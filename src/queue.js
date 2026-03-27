'use strict';
/**
 * queue.js
 * In-memory job queue with SQLite persistence for crash recovery.
 * Jobs flow: pending â†’ processing â†’ done | failed
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');

const DB_PATH = path.resolve(process.cwd(), 'data', 'queue.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    pdf_size    INTEGER,
    copies      INTEGER DEFAULT 1,
    label       TEXT,
    retries     INTEGER DEFAULT 0,
    error       TEXT,
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_created ON jobs(created_at DESC);
`);

// In-memory queue of job IDs + PDF buffers (not stored in SQLite to avoid huge DB)
const pendingQueue = [];
const activeJobs = new Map(); // id â†’ { pdfBuffer, copies, label }

// On startup, mark any jobs that were mid-flight as failed (crashed)
db.prepare(`
  UPDATE jobs SET status='failed', error='Agent restarted mid-job', updated_at=?
  WHERE status='processing'
`).run(Date.now());

// Re-enqueue pending jobs from last run (without PDF buffers â€“ they need re-submission)
// In practice, Odoo will retry, so we just mark them failed cleanly
db.prepare(`
  UPDATE jobs SET status='failed', error='Agent restarted - please reprint', updated_at=?
  WHERE status='pending'
`).run(Date.now());

const insertJob = db.prepare(`
  INSERT INTO jobs (id, status, created_at, updated_at, pdf_size, copies, label, retries)
  VALUES (@id, 'pending', @ts, @ts, @pdf_size, @copies, @label, 0)
`);
const updateJob = db.prepare(`
  UPDATE jobs SET status=@status, updated_at=@ts, retries=@retries, error=@error, completed_at=@completed_at
  WHERE id=@id
`);
const getJob = db.prepare(`SELECT * FROM jobs WHERE id=?`);
const listJobs = db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`);

/**
 * Add a job to the queue
 */
function enqueue(pdfBuffer, { copies = 1, label = null } = {}) {
  const id = crypto.randomUUID();
  const ts = Date.now();
  insertJob.run({ id, ts, pdf_size: pdfBuffer.length, copies, label });
  pendingQueue.push(id);
  activeJobs.set(id, { pdfBuffer, copies, label });
  logger.info('Job enqueued', { jobId: id, copies, pdfSize: pdfBuffer.length });
  return id;
}

/**
 * Get next pending job from queue
 * Returns null if queue is empty
 */
function dequeue() {
  const id = pendingQueue.shift();
  if (!id) return null;
  const data = activeJobs.get(id);
  if (!data) return null;
  const ts = Date.now();
  db.prepare(`UPDATE jobs SET status='processing', updated_at=? WHERE id=?`).run(ts, id);
  return { id, ...data };
}

function markDone(id) {
  const ts = Date.now();
  updateJob.run({ id, status: 'done', ts, retries: getJob.get(id)?.retries || 0, error: null, completed_at: ts });
  activeJobs.delete(id);
  logger.info('Job completed', { jobId: id });
}

function markFailed(id, error, retry = false) {
  const job = getJob.get(id);
  const retries = (job?.retries || 0) + 1;
  const ts = Date.now();
  const canRetry = retry && retries <= config.queue.maxRetries;
  const status = canRetry ? 'pending' : 'failed';
  updateJob.run({ id, status, ts, retries, error: error.toString().substring(0, 500), completed_at: canRetry ? null : ts });

  if (canRetry) {
    const data = activeJobs.get(id);
    if (data) {
      logger.warn('Job failed, retrying', { jobId: id, retries, maxRetries: config.queue.maxRetries });
      setTimeout(() => pendingQueue.push(id), config.queue.retryDelay);
    }
  } else {
    activeJobs.delete(id);
    logger.error('Job permanently failed', { jobId: id, error: error.toString() });
  }
}

function getJobStatus(id) {
  return getJob.get(id) || null;
}

function getRecentJobs(limit = 50) {
  return listJobs.all(limit);
}

function queueLength() {
  return pendingQueue.length;
}

module.exports = { enqueue, dequeue, markDone, markFailed, getJobStatus, getRecentJobs, queueLength };
