'use strict';

/**
 * converter.js
 *
 * Converts a PDF buffer to ZPL using:
 *   1. Ghostscript — rasterizes PDF pages to greyscale PNG
 *   2. Sharp       — resizes (preserving aspect ratio) and thresholds to 1-bit
 *   3. Bit packing — encodes as ZPL ^GFA with run-length compression
 *
 * Requires:
 *   - Ghostscript installed and on PATH (or GS_PATH set in .env)
 *   - sharp npm package: npm install sharp
 */

const { execFile } = require('child_process');
const fs           = require('fs');
const os           = require('os');
const path         = require('path');
const sharp        = require('sharp');
const config       = require('./config');
const logger       = require('./logger');

const MM_TO_INCH = 1 / 25.4;

/**
 * Convert a PDF buffer to a ZPL string.
 * @param {Buffer} pdfBuffer
 * @param {{ copies?: number }} opts
 * @returns {Promise<string>}
 */
async function pdfToZpl(pdfBuffer, opts = {}) {
  const copies      = opts.copies || 1;
  const dpi         = config.printer.dpi;
  const widthDots   = Math.round(config.printer.labelWidthMm * MM_TO_INCH * dpi);

  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'labelcast-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);

  try {
    const pngPattern = path.join(tmpDir, 'page-%03d.png');
    await ghostscriptRasterize(pdfPath, pngPattern, dpi);

    const pages = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('page-') && f.endsWith('.png'))
      .sort();

    if (pages.length === 0) throw new Error('Ghostscript produced no output pages');
    logger.info(`PDF rasterized to ${pages.length} page(s)`, { dpi, widthDots });

    const zplParts = [];
    for (const page of pages) {
      const imgPath = path.join(tmpDir, page);
      const zpl     = await pngToZpl(imgPath, widthDots, dpi);
      for (let i = 0; i < copies; i++) zplParts.push(zpl);
    }

    return zplParts.join('\n');

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Rasterize a PDF to greyscale PNG files using Ghostscript.
 */
function ghostscriptRasterize(pdfPath, outputPattern, dpi) {
  return new Promise((resolve, reject) => {
    const gsPath = config.conversion.gsPath || 'gswin64c';
    const args   = [
      '-dNOPAUSE', '-dBATCH', '-dSAFER',
      '-sDEVICE=pnggray',
      `-r${dpi}`,
      '-dGraphicsAlphaBits=4',
      '-dTextAlphaBits=4',
      `-sOutputFile=${outputPattern}`,
      pdfPath,
    ];

    logger.debug('Running Ghostscript', { gsPath, dpi });

    execFile(gsPath, args, { timeout: 60000 }, (err, _stdout, stderr) => {
      if (err) {
        const msg = err.code === 'ENOENT'
          ? `Ghostscript not found at "${gsPath}". Install from https://ghostscript.com/releases/gsdnld.html and tick "Add to PATH", or set GS_PATH in .env`
          : `Ghostscript error: ${err.message}\n${stderr}`;
        logger.error('Ghostscript failed', { error: msg });
        return reject(new Error(msg));
      }
      resolve();
    });
  });
}

/**
 * Convert a greyscale PNG to a ZPL ^GFA label string.
 * Preserves aspect ratio — does not distort barcodes.
 */
async function pngToZpl(imgPath, targetWidthDots, dpi) {
  const meta = await sharp(imgPath).metadata();

  // Preserve aspect ratio — only constrain width, let height scale naturally
  const heightDots = config.printer.labelHeightMm > 0
    ? Math.round(config.printer.labelHeightMm * MM_TO_INCH * dpi)
    : Math.round((meta.height / meta.width) * targetWidthDots);

  // Resize preserving aspect ratio, then threshold to pure 1-bit
  const rawData = await sharp(imgPath)
    .resize(targetWidthDots, heightDots, {
      fit:    'contain',      // preserve aspect ratio — no distortion
      kernel: 'lanczos3',
      background: { r: 255, g: 255, b: 255 },
    })
    .grayscale()
    .threshold(128)
    .raw()
    .toBuffer();

  // Pack 8 pixels per byte (MSB first), 1 = black in ZPL
  const bytesPerRow = Math.ceil(targetWidthDots / 8);
  const totalBytes  = bytesPerRow * heightDots;
  const packed      = Buffer.alloc(totalBytes, 0);

  for (let y = 0; y < heightDots; y++) {
    for (let x = 0; x < targetWidthDots; x++) {
      const pixel = rawData[y * targetWidthDots + x];
      if (pixel === 0) {
        const byteIdx = y * bytesPerRow + Math.floor(x / 8);
        const bitIdx  = 7 - (x % 8);
        packed[byteIdx] |= (1 << bitIdx);
      }
    }
  }

  const hexData = compressZplData(packed, bytesPerRow, heightDots);

  return [
    '^XA',
    '^FO0,0',
    `^GFA,${totalBytes},${totalBytes},${bytesPerRow},${hexData}`,
    '^XZ',
  ].join('\n');
}

/**
 * ZPL run-length compression for ^GFA hex data.
 * Repeated hex characters are encoded as count + char.
 */
function compressZplData(buffer, bytesPerRow, rows) {
  const HEX = '0123456789ABCDEF';

  const repeatChar = (n) => {
    if (n <= 0) return '';
    const high = 'GHIJKLMNOPQRSTUVWXY';
    const low  = 'ghijklmnopqrstuvwxy';
    let out    = '';
    const h    = Math.floor(n / 20);
    const l    = n % 20;
    if (h > 0 && h - 1 < high.length) out += high[h - 1];
    if (l > 0 && l - 1 < low.length)  out += low[l - 1];
    return out || '';
  };

  let result = '';
  for (let y = 0; y < rows; y++) {
    let rowHex = '';
    for (let x = 0; x < bytesPerRow; x++) {
      const b = buffer[y * bytesPerRow + x];
      rowHex += HEX[b >> 4] + HEX[b & 0xf];
    }

    let compressed = '';
    let i = 0;
    while (i < rowHex.length) {
      const ch    = rowHex[i];
      let   count = 1;
      while (i + count < rowHex.length && rowHex[i + count] === ch && count < 399) count++;
      compressed += count > 2 ? repeatChar(count) + ch : ch.repeat(count);
      i += count;
    }

    result += compressed + ':';
  }
  return result;
}

module.exports = { pdfToZpl };
