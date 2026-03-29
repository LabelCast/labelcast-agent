'use strict';

/**
 * config.js
 * Central configuration — reads from environment variables set in .env
 * All modules import this instead of reading process.env directly.
 */

require('dotenv').config();

const config = {
  server: {
    port:    parseInt(process.env.AGENT_PORT  || '7777', 10),
    host:    process.env.AGENT_HOST           || '0.0.0.0',
    apiToken: process.env.API_TOKEN           || '',
  },

  printer: {
    host:          process.env.PRINTER_HOST   || 'localhost',
    port:          parseInt(process.env.PRINTER_PORT    || '9100', 10),
    timeout:       parseInt(process.env.PRINTER_TIMEOUT || '10000', 10),
    dpi:           parseInt(process.env.PRINTER_DPI     || '203', 10),
    labelWidthMm:  parseFloat(process.env.LABEL_WIDTH_MM  || '100'),
    labelHeightMm: parseFloat(process.env.LABEL_HEIGHT_MM || '0'),
  },

  conversion: {
    gsPath: process.env.GS_PATH || 'gswin64c',
  },

  queue: {
    maxHistory:  parseInt(process.env.QUEUE_MAX_HISTORY  || '200', 10),
    maxRetries:  parseInt(process.env.QUEUE_MAX_RETRIES  || '3', 10),
    retryDelay:  parseInt(process.env.QUEUE_RETRY_DELAY  || '5000', 10),
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY  || '1', 10),
  },

  logging: {
    level:  process.env.LOG_LEVEL || 'info',
    dir:    process.env.LOG_DIR   || 'logs',
  },
};

module.exports = config;
