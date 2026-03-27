'use strict';
/**
 * converter.js
 * Converts a PDF buffer to ZPL using:
 *   1. Ghostscript to rasterize PDF â†’ PNG (high quality)
 *   2. Sharp to threshold/dither the PNG to 1-bit
 *   3. Encode as ZPL ~GFA (compressed graphic field)
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const config = require('./config');
const logger = require('./logger');

const MM_TO_INCH = 1 / 25.4;

/**
 * Convert PDF pages to ZPL strings
 * @param {Buffer} pdfBuffer
 * @param {object} opts  { copies: 1 }
 * @returns {Promise<string>}  Full ZPL document (all pages/labels)
 */
async function pdfToZpl(pdfBuffer, opts = {}) {
  const copies = opts.copies || 1;
  const dpi = config.printer.dpi;
  const widthDots = Math.round(config.printer.labelWidthMm * MM_TO_INCH * dpi);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zebra-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);

  try {
    // Step 1: Rasterize with Ghostscript
    const pngPattern = path.join(tmpDir, 'page-%03d.png');
    await ghostscriptRasterize(pdfPath, pngPattern, dpi);

    // Step 2: Find rendered pages
    const pages = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('page-') && f.endsWith('.png'))
      .sort();

    if (pages.length === 0) throw new Error('Ghostscript produced no output pages');
    logger.info(`Converted PDF to ${pages.length} PNG page(s)`, { dpi, widthDots });

    // Step 3: Convert each page PNG to ZPL
    const zplParts = [];
    for (const page of pages) {
      const imgPath = path.join(tmpDir, page);
      const zpl = await pngToZpl(imgPath, widthDots, dpi);
      for (let i = 0; i < copies; i++) zplParts.push(zpl);
    }

    return zplParts.join('\n');
  } finally {
    // Cleanup temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Run Ghostscript to convert PDF â†’ PNG files
 */
function ghostscriptRasterize(pdfPath, outputPattern, dpi) {
  return new Promise((resolve, reject) => {
    const args = [
      '-dNOPAUSE', '-dBATCH', '-dSAFER',
      '-sDEVICE=pnggray',
      `-r${dpi}`,
      '-dGraphicsAlphaBits=4',
      '-dTextAlphaBits=4',
      `-sOutputFile=${outputPattern}`,
      pdfPath
    ];

    logger.debug('Running Ghostscript', { gsPath: config.conversion.gsPath, args: args.join(' ') });

    execFile(config.conversion.gsPath, args, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        logger.error('Ghostscript failed', { err: err.message, stderr });
        return reject(new Error(`Ghostscript error: ${err.message}\n${stderr}`));
      }
      resolve();
    });
  });
}

/**
 * Convert a grayscale PNG to ZPL ~GFA (compressed graphic)
 */
async function pngToZpl(imgPath, targetWidthDots, dpi) {
  // Resize to exact label width, let height auto-scale
  const meta = await sharp(imgPath).metadata();
  const heightDots = config.printer.labelHeightMm > 0
    ? Math.round(config.printer.labelHeightMm * MM_TO_INCH * dpi)
    : Math.round((meta.height / meta.width) * targetWidthDots);

  // Convert to 1-bit via threshold (Floyd-Steinberg dither via threshold)
  const rawData = await sharp(imgPath)
    .resize(targetWidthDots, heightDots, { fit: 'fill', kernel: 'lanczos3' })
    .grayscale()
    .threshold(128)  // binary threshold; adjust for label content
    .raw()
    .toBuffer();

  // Pack bits: each pixel is 0 or 255; pack 8 pixels per byte (1=black for ZPL)
  const bytesPerRow = Math.ceil(targetWidthDots / 8);
  const totalBytes = bytesPerRow * heightDots;
  const packed = Buffer.alloc(totalBytes, 0);

  for (let y = 0; y < heightDots; y++) {
    for (let x = 0; x < targetWidthDots; x++) {
      const pixel = rawData[y * targetWidthDots + x];
      if (pixel === 0) { // black pixel
        const byteIndex = y * bytesPerRow + Math.floor(x / 8);
        const bitIndex = 7 - (x % 8);
        packed[byteIndex] |= (1 << bitIndex);
      }
    }
  }

  // Compress using ZPL Z64 (base64 + CRC) for efficiency
  const hexData = compressZplData(packed, bytesPerRow, heightDots);

  const zpl = [
    '^XA',
    `^FO0,0`,
    `^GFA,${totalBytes},${totalBytes},${bytesPerRow},${hexData}`,
    '^XZ'
  ].join('\n');

  return zpl;
}

/**
 * ZPL hex encoding with repeat-character compression
 * Uses ZPL's built-in run-length encoding: repeats encoded as count+char
 */
function compressZplData(buffer, bytesPerRow, rows) {
  const hexChars = '0123456789ABCDEF';
  // Map count to ZPL repeat chars (1=G, 2=H ... 19=Z, 20=g, etc.)
  const repeatChar = (n) => {
    if (n === 0) return '';
    const highCodes = 'GHIJKLMNOPQRSTUVWXY';
    const lowCodes  = 'ghijklmnopqrstuvwxy';
    let out = '';
    const high = Math.floor(n / 20);
    const low  = n % 20;
    if (high > 0) out += highCodes[high - 1] || '';
    if (low > 0)  out += lowCodes[low - 1];
    return out;
  };

  let result = '';
  for (let y = 0; y < rows; y++) {
    let rowHex = '';
    for (let x = 0; x < bytesPerRow; x++) {
      const b = buffer[y * bytesPerRow + x];
      rowHex += hexChars[b >> 4] + hexChars[b & 0xf];
    }

    // Run-length compress the hex row
    let compressed = '';
    let i = 0;
    while (i < rowHex.length) {
      const ch = rowHex[i];
      let count = 1;
      while (i + count < rowHex.length && rowHex[i + count] === ch && count < 399) count++;
      if (count > 2) {
        compressed += repeatChar(count) + ch;
      } else {
        compressed += ch.repeat(count);
      }
      i += count;
    }

    // If entire row is same as previous, use ':'
    result += compressed + ':';
  }
  return result;
}

module.exports = { pdfToZpl };
