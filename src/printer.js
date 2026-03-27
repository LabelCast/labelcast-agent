'use strict';
/**
 * printer.js
 * Sends ZPL data to Zebra printer via TCP socket on port 9100
 */

const net = require('net');
const config = require('./config');
const logger = require('./logger');

/**
 * Send raw ZPL string to printer via TCP
 * @param {string} zpl
 * @returns {Promise<void>}
 */
function sendZpl(zpl) {
  return new Promise((resolve, reject) => {
    const { host, port, timeout } = config.printer;
    const socket = new net.Socket();

    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };

    socket.setTimeout(timeout);

    socket.connect(port, host, () => {
      logger.debug('TCP connected to printer', { host, port });
      socket.write(zpl, 'utf8', (err) => {
        if (err) return done(err);
        // Give the printer a moment to accept all data before closing
        setTimeout(() => done(), 500);
      });
    });

    socket.on('timeout', () => {
      logger.warn('Printer TCP connection timed out', { host, port, timeout });
      done(new Error(`Printer connection timed out after ${timeout}ms`));
    });

    socket.on('error', (err) => {
      logger.error('Printer TCP error', { err: err.message, host, port });
      done(new Error(`Printer error: ${err.message}`));
    });

    socket.on('close', () => {
      // Normal close after we called destroy
      done();
    });
  });
}

/**
 * Quick ping: attempt TCP connect to verify printer is reachable
 * @returns {Promise<{reachable: boolean, latencyMs: number|null, error: string|null}>}
 */
function pingPrinter() {
  const start = Date.now();
  return new Promise((resolve) => {
    const { host, port } = config.printer;
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
      resolve({ reachable: false, latencyMs: null, error: 'timeout' });
    });
  });
}

module.exports = { sendZpl, pingPrinter };
