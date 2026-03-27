'use strict';

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const { enqueue, getJob, listJobs } = require('./queue');
const { pingPrinter } = require('./printer');
const logger = require('./logger');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
});

// â”€â”€ Auth middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function authMiddleware(req, res, next) {
  const token = process.env.API_TOKEN;
  if (!token || token === '') return next(); // auth disabled

  const provided =
    req.headers['x-print-token'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '');

  if (provided !== token) {
    logger.warn('Unauthorized request', { ip: req.ip, path: req.path });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use(express.json());

// â”€â”€ Health check (no auth) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/health', async (_req, res) => {
  const printer = await pingPrinter();
  res.json({
    status: 'ok',
    agent: 'zebra-print-agent',
    version: require('../package.json').version,
    printer,
    timestamp: new Date().toISOString(),
  });
});

// â”€â”€ All other routes require auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(authMiddleware);

/**
 * POST /print
 *
 * Accepts a PDF in one of three ways:
 *   1. Multipart field named "pdf" (file upload)
 *   2. Raw binary body with Content-Type: application/pdf
 *   3. JSON body: { "pdf": "<base64>", "copies": 1, "label": "shipping" }
 *
 * Returns: { jobId, status, message }
 */
app.post(
  '/print',
  upload.single('pdf'),
  async (req, res) => {
    let pdfBuffer;
    let copies = 1;
    let labelName = 'label';

    try {
      // â”€â”€ Source 1: multipart file upload â”€â”€
      if (req.file) {
        pdfBuffer = req.file.buffer;
        copies = req.body.copies || 1;
        labelName = req.body.label || req.file.originalname || 'label';
      }
      // â”€â”€ Source 2: raw PDF body â”€â”€
      else if (
        req.headers['content-type']?.includes('application/pdf')
      ) {
        // Read raw body (express.json() won't have parsed this)
        pdfBuffer = await readRawBody(req);
        copies = req.query.copies || 1;
        labelName = req.query.label || 'label';
      }
      // â”€â”€ Source 3: JSON with base64 â”€â”€
      else if (req.body?.pdf) {
        pdfBuffer = Buffer.from(req.body.pdf, 'base64');
        copies = req.body.copies || 1;
        labelName = req.body.label || 'label';
      } else {
        return res.status(400).json({
          error: 'No PDF provided. Send as multipart "pdf" field, raw application/pdf body, or JSON { pdf: "<base64>" }',
        });
      }

      if (!pdfBuffer || pdfBuffer.length === 0) {
        return res.status(400).json({ error: 'PDF buffer is empty' });
      }

      // Basic PDF magic bytes check
      if (pdfBuffer.slice(0, 4).toString() !== '%PDF') {
        return res.status(400).json({ error: 'File does not appear to be a valid PDF' });
      }

      const job = enqueue(pdfBuffer, { copies, labelName });

      logger.info('Print job accepted', {
        jobId: job.id,
        labelName: job.labelName,
        copies: job.copies,
        sizeKb: Math.round(pdfBuffer.length / 1024),
        ip: req.ip,
      });

      return res.status(202).json({
        jobId: job.id,
        status: job.status,
        message: 'Job queued successfully',
      });
    } catch (err) {
      logger.error('Error accepting print job', { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  }
);

/**
 * GET /jobs
 * Returns the last 50 print jobs with their status.
 */
app.get('/jobs', (_req, res) => {
  res.json(listJobs());
});

/**
 * GET /jobs/:id
 * Returns a single job's status.
 */
app.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

/**
 * GET /printer/status
 * Pings the Zebra printer and returns connectivity status.
 */
app.get('/printer/status', async (_req, res) => {
  const result = await pingPrinter();
  res.status(result.ok ? 200 : 503).json(result);
});

// â”€â”€ 404 fallback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// â”€â”€ Start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PORT = parseInt(process.env.AGENT_PORT || '7777', 10);
const HOST = process.env.AGENT_HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  logger.info(`âœ“ Zebra Print Agent started`, {
    url: `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`,
    printer: `${process.env.PRINTER_HOST}:${process.env.PRINTER_PORT || 9100}`,
    auth: process.env.API_TOKEN ? 'enabled' : 'DISABLED (set API_TOKEN in .env)',
  });
});

module.exports = app; // for testing
