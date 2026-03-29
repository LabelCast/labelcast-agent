'use strict';

require('dotenv').config();

const express  = require('express');
const multer   = require('multer');
const config   = require('./config');
const { enqueue, getJobStatus, getRecentJobs } = require('./queue');
const { pingPrinter } = require('./printer');
const logger   = require('./logger');

const app    = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
});

// ── Auth middleware ────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = config.server.apiToken;
  if (!token) return next();

  const provided =
    req.headers['x-print-token'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '');

  if (provided !== token) {
    logger.warn('Unauthorized request', { ip: req.ip, path: req.path });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use(express.json({ limit: '55mb' }));

// ── Health check — no auth required ───────────────────────────────────────
app.get('/health', async (_req, res) => {
  const ping = await pingPrinter();
  res.json({
    status:    'ok',
    agent:     'labelcast-agent',
    version:   require('../package.json').version,
    printer: {
      ok:        ping.reachable,
      message:   ping.reachable ? `Reachable (${ping.latencyMs}ms)` : ping.error,
      latencyMs: ping.latencyMs,
    },
    timestamp: new Date().toISOString(),
  });
});

app.use(authMiddleware);

/**
 * POST /print
 * Accepts PDF via multipart, raw body, or JSON base64.
 * Returns: { jobId, status, message }
 */
app.post('/print', upload.single('pdf'), async (req, res) => {
  let pdfBuffer;
  let copies    = 1;
  let labelName = 'label';

  try {
    if (req.file) {
      pdfBuffer = req.file.buffer;
      copies    = parseInt(req.body.copies || '1', 10);
      labelName = req.body.label || req.file.originalname || 'label';
    } else if (req.headers['content-type']?.includes('application/pdf')) {
      pdfBuffer = await readRawBody(req);
      copies    = parseInt(req.query.copies || '1', 10);
      labelName = req.query.label || 'label';
    } else if (req.body?.pdf) {
      pdfBuffer = Buffer.from(req.body.pdf, 'base64');
      copies    = parseInt(req.body.copies || '1', 10);
      labelName = req.body.label || 'label';
    } else {
      return res.status(400).json({
        error: 'No PDF provided. Send as multipart "pdf" field, raw application/pdf body, or JSON { pdf: "<base64>" }',
      });
    }

    if (!pdfBuffer || pdfBuffer.length === 0) {
      return res.status(400).json({ error: 'PDF buffer is empty' });
    }

    if (pdfBuffer.slice(0, 4).toString() !== '%PDF') {
      return res.status(400).json({ error: 'File does not appear to be a valid PDF' });
    }

    const jobId = enqueue(pdfBuffer, { copies, label: labelName });

    logger.info('Print job accepted', {
      jobId,
      labelName,
      copies,
      sizeKb: Math.round(pdfBuffer.length / 1024),
      ip: req.ip,
    });

    return res.status(202).json({
      jobId,
      status:  'queued',
      message: 'Job queued successfully',
    });

  } catch (err) {
    logger.error('Error accepting print job', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

app.get('/jobs', (_req, res) => {
  res.json(getRecentJobs());
});

app.get('/jobs/:id', (req, res) => {
  const job = getJobStatus(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/printer/status', async (_req, res) => {
  const ping = await pingPrinter();
  res.status(ping.reachable ? 200 : 503).json({
    ok:        ping.reachable,
    message:   ping.reachable ? `Printer reachable (${ping.latencyMs}ms)` : ping.error,
    latencyMs: ping.latencyMs,
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data',  (c) => chunks.push(c));
    req.on('end',   ()  => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const { port, host, apiToken } = config.server;

app.listen(port, host, () => {
  logger.info('LabelCast agent started', {
    url:     `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
    printer: `${config.printer.host}:${config.printer.port}`,
    auth:    apiToken ? 'enabled' : 'DISABLED — set API_TOKEN in .env',
  });
});

module.exports = app;
