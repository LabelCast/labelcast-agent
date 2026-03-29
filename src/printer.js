'use strict';

/**
 * printer.js
 *
 * Sends raw ZPL to a Zebra printer via TCP socket on port 9100.
 * Uses config.js for host/port/timeout — no direct process.env reads.
 */

const net    = require('net');
const config = require('./config');
const logger = require('./logger');

/**
 * Send a ZPL string to the printer.
 * @param {string} zpl
 * @returns {Promise<void>}
 */
function sendZpl(zpl) {
  return new Promise((resolve, reject) => {
    const { host, port, timeout } = config.printer;

    if (!host || host === 'localhost') {
      return reject(new Error('PRINTER_HOST is not configured in .env'));
    }

    const socket   = new net.Socket();
    let   settled  = false;

    const done = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };

    socket.setTimeout(timeout);

    socket.connect(port, host, () => {
      logger.debug('TCP connected to printer', { host, port });
      socket.write(Buffer.from(zpl, 'utf8'), (writeErr) => {
        if (writeErr) return done(writeErr);
        // Give the printer time to receive all data before closing
        setTimeout(() => done(), 500);
      });
    });

    socket.on('timeout', () => {
      logger.warn('Printer connection timed out', { host, port, timeout });
      done(new Error(`Printer connection timed out after ${timeout}ms`));
    });

    socket.on('error', (err) => {
      logger.error('Printer TCP error', { error: err.message, host, port });
      done(new Error(`Printer error: ${err.message}`));
    });
  });
}

/**
 * Quick reachability check — attempts TCP connect and measures latency.
 * Returns a consistent shape used by both /health and /printer/status.
 *
 * @returns {Promise<{ reachable: boolean, latencyMs: number|null, error: string|null }>}
 */
function pingPrinter() {
  const start = Date.now();
  return new Promise((resolve) => {
    const { host, port } = config.printer;

    if (!host || host === 'localhost') {
      return resolve({ reachable: false, latencyMs: null, error: 'PRINTER_HOST not configured' });
    }

    const socket = new net.Socket();
    socket.setTimeout(5000);

    socket.connect(port, host, () => {
      const latencyMs = Date.now() - start;
      socket.destroy();
      resolve({ reachable: true, latencyMs, error: null });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({ reachable: false, latencyMs: null, error: err.message });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ reachable: false, latencyMs: null, error: 'Connection timed out' });
    });
  });
}

module.exports = { sendZpl, pingPrinter };
