'use strict';
require('dotenv').config();
const winston = require('winston');
const path = require('path');
const fs = require('fs');

const logDir = path.resolve(process.cwd(), process.env.LOG_DIR || 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const fmt = winston.format;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: fmt.combine(
    fmt.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    fmt.errors({ stack: true }),
    fmt.json()
  ),
  transports: [
    new winston.transports.Console({
      format: fmt.combine(
        fmt.colorize(),
        fmt.printf(({ timestamp, level, message, ...meta }) => {
          const extras = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
          return `${timestamp} [${level}] ${message}${extras}`;
        })
      )
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'agent.log'),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3
    })
  ]
});

module.exports = logger;
