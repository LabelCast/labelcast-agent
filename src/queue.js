'use strict';

/**
 * queue.js
 *
 * In-memory print queue with SQLite persistence for job history.
 * PDF buffers are kept in memory only (not in SQLite).
 * Jobs that were mid-flight on startup are marked failed cleanly.
 *
 * Exports: enqueue, getJobStatus, getRecentJobs, queueLength
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const config   = require('./config');
const logger   = require('./logger');

// ── Database setup ─────────────────────────────────────────────────────────
const DB_DIR  = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'queue.db');
fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    completed_at INTEGER,
    pdf_size     INTEGER,
    copies       INTEGER DEFAULT 1,
    label        TEXT,
    retries      INTEGER DEFAULT 0,
    error        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_status  ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_created ON jobs(created_at DESC);
`);

// Mark any jobs that were mid-flight when agent last stopped as failed
db.prepare(`
  UPDATE jobs
  SET    status = 'failed', error = 'Agent restarted mid-job', updated_at = ?
  WHERE  status = 'processing'
`).run(Date.now());

db.prepare(`
  UPDATE jobs
  SET    status = 'failed', error = 'Agent restarted — please reprint', updated_at = ?
  WHERE  status = 'pending'
`).run(Date.now());

// ── Prepared statements ────────────────────────────────────────────────────
const stmtInsert = db.prepare(`
  INSERT INTO jobs (id, status, created_at, updated_at, pdf_size, copies, label, retries)
  VALUES (@id, 'pending', @ts, @ts, @pdfSize, @copies, @label, 0)
`);

const stmtUpdate = db.prepare(`
  UPDATE jobs
  SET    status = @status, updated_at = @ts, retries = @retries,
         error = @error, completed_at = @completedAt
  WHERE  id = @id
`);

const stmtGetOne  = db.prepare(`SELECT * FROM jobs WHERE id = ?`);
const stmtGetMany = db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`);

// ── In-memory state ────────────────────────────────────────────────────────
const pendingQueue = [];          // ordered list of job IDs
const activeJobs   = new Map();   // id → { pdfBuffer, copies, label }
let   processing   = false;

// ── Worker loop ────────────────────────────────────────────────────────────
async function processNext() {
  if (processing || pendingQueue.length === 0) return;
  processing = true;

  const id   = pendingQueue.shift();
  const data = activeJobs.get(id);

  if (!data) {
    processing = false;
    setImmediate(processNext);
    return;
  }

  db.prepare(`UPDATE jobs SET status = 'processing', updated_at = ? WHERE id = ?`)
    .run(Date.now(), id);

  logger.info('Processing print job', { jobId: id, label: data.label, copies: data.copies });

  try {
    const { pdfToZpl }    = require('./converter');
    const { sendZpl }     = require('./printer');
    const zpl = await pdfToZpl(data.pdfBuffer, { copies: data.copies });
    await sendZpl(zpl);

    const ts = Date.now();
    stmtUpdate.run({ id, status: 'done', ts, retries: 0, error: null, completedAt: ts });
    activeJobs.delete(id);
    logger.info('Print job completed', { jobId: id });

  } catch (err) {
    const row     = stmtGetOne.get(id);
    const retries = (row?.retries || 0) + 1;
    const ts      = Date.now();

    if (retries <= config.queue.maxRetries) {
      stmtUpdate.run({ id, status: 'pending', ts, retries, error: err.message, completedAt: null });
      logger.warn('Print job failed, will retry', { jobId: id, retries, error: err.message });
      setTimeout(() => {
        pendingQueue.push(id);
        setImmediate(processNext);
      }, config.queue.retryDelay);
    } else {
      stmtUpdate.run({ id, status: 'failed', ts, retries, error: err.message, completedAt: ts });
      activeJobs.delete(id);
      logger.error('Print job permanently failed', { jobId: id, error: err.message });
    }
  } finally {
    processing = false;
    setImmediate(processNext);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Add a job to the queue.
 * @param {Buffer} pdfBuffer
 * @param {{ copies?: number, label?: string }} opts
 * @returns {string} jobId
 */
function enqueue(pdfBuffer, { copies = 1, label = 'label' } = {}) {
  const id = crypto.randomUUID();
  const ts = Date.now();

  stmtInsert.run({ id, ts, pdfSize: pdfBuffer.length, copies, label });
  pendingQueue.push(id);
  activeJobs.set(id, { pdfBuffer, copies, label });

  logger.info('Job enqueued', { jobId: id, label, copies, pdfSize: pdfBuffer.length });
  setImmediate(processNext);

  return id;
}

/**
 * Get a single job's status by ID.
 * @param {string} id
 * @returns {object|null}
 */
function getJobStatus(id) {
  return stmtGetOne.get(id) || null;
}

/**
 * Get recent jobs (default 50).
 * @param {number} limit
 * @returns {object[]}
 */
function getRecentJobs(limit = config.queue.maxHistory) {
  return stmtGetMany.all(limit);
}

/**
 * How many jobs are waiting.
 * @returns {number}
 */
function queueLength() {
  return pendingQueue.length;
}

module.exports = { enqueue, getJobStatus, getRecentJobs, queueLength };
