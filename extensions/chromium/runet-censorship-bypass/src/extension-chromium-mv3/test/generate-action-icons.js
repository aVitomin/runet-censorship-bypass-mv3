'use strict';

/* eslint-disable no-bitwise */

// From the extension tooling root:
// node ./src/extension-chromium-mv3/test/generate-action-icons.js

const Fs = require('fs');
const Path = require('path');
const Zlib = require('zlib');

const ICON_DIRECTORY = Path.resolve(__dirname, '..', 'icons');
const VARIANT_SIZES = Object.freeze({
  active: Object.freeze([16, 19, 20, 32, 38, 48, 128]),
  off: Object.freeze([16, 19, 20, 32, 38]),
  external: Object.freeze([16, 19, 20, 32, 38]),
  busy: Object.freeze([16, 19, 20, 32, 38]),
  warning: Object.freeze([16, 19, 20, 32, 38]),
  loading: Object.freeze([16, 19, 20, 32, 38]),
});
const COLORS = Object.freeze({
  outline: Object.freeze([15, 23, 42, 255]),
  active: Object.freeze([37, 99, 235, 255]),
  off: Object.freeze([148, 163, 184, 255]),
  offInner: Object.freeze([226, 232, 240, 255]),
  external: Object.freeze([107, 33, 168, 255]),
  warning: Object.freeze([217, 119, 6, 255]),
  white: Object.freeze([255, 255, 255, 255]),
  transparent: Object.freeze([0, 0, 0, 0]),
});
const CRC_TABLE = createCrcTable();

function createCrcTable() {

  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;

}

function crc32(buffer) {

  let crc = 0xffffffff;
  for (const value of buffer) {
    crc = CRC_TABLE[(crc ^ value) & 0xff] ^ crc >>> 8;
  }
  return (crc ^ 0xffffffff) >>> 0;

}

function createChunk(type, data) {

  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(body), data.length + 8);
  return chunk;

}

function encodePng(width, height, pixels) {

  const stride = width * 4;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    rows[rowOffset] = 0;
    Buffer.from(
        pixels.buffer,
        pixels.byteOffset + y * stride,
        stride,
    ).copy(rows, rowOffset + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    createChunk('IHDR', header),
    createChunk('IDAT', Zlib.deflateSync(rows, {level: 9})),
    createChunk('IEND', Buffer.alloc(0)),
  ]);

}

function setPixel(pixels, width, x, y, color) {

  if (x < 0 || y < 0 || x >= width || y >= width) {
    return;
  }
  const offset = (y * width + x) * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = color[3];

}

function pointInPolygon(x, y, points) {

  let inside = false;
  for (
    let current = 0, previous = points.length - 1;
    current < points.length;
    previous = current, current += 1
  ) {
    const currentPoint = points[current];
    const previousPoint = points[previous];
    const crosses = currentPoint[1] > y !== previousPoint[1] > y &&
      x < (previousPoint[0] - currentPoint[0]) *
      (y - currentPoint[1]) /
      (previousPoint[1] - currentPoint[1]) +
      currentPoint[0];
    if (crosses) {
      inside = !inside;
    }
  }
  return inside;

}

function fillPolygon(pixels, width, points, color) {

  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pointInPolygon(x + 0.5, y + 0.5, points)) {
        setPixel(pixels, width, x, y, color);
      }
    }
  }

}

function distanceToSegment(x, y, start, end) {

  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(
      1,
      ((x - start[0]) * deltaX + (y - start[1]) * deltaY) /
        lengthSquared,
  ));
  const nearestX = start[0] + ratio * deltaX;
  const nearestY = start[1] + ratio * deltaY;
  return Math.hypot(x - nearestX, y - nearestY);

}

function drawLine(pixels, width, start, end, thickness, color) {

  const radius = thickness / 2;
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (distanceToSegment(x + 0.5, y + 0.5, start, end) <= radius) {
        setPixel(pixels, width, x, y, color);
      }
    }
  }

}

function fillCircle(pixels, width, center, radius, color) {

  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (Math.hypot(x + 0.5 - center[0], y + 0.5 - center[1]) <= radius) {
        setPixel(pixels, width, x, y, color);
      }
    }
  }

}

function scalePoints(points, width, factor = 1) {

  return points.map(([x, y]) => [
    width * (0.5 + (x - 0.5) * factor),
    width * (0.5 + (y - 0.5) * factor),
  ]);

}

function drawRoute(pixels, width, color, variant) {

  const scale = width;
  const thickness = scale * (variant === 'loading' ? 0.075 : 0.09);
  const stemStart = [scale * 0.5, scale * 0.74];
  const junction = [scale * 0.5, scale * 0.45];
  const left = [scale * 0.34, scale * 0.31];
  const right = [scale * 0.66, scale * 0.31];
  drawLine(pixels, width, stemStart, junction, thickness, color);
  drawLine(pixels, width, junction, left, thickness, color);
  drawLine(pixels, width, junction, right, thickness, color);
  if (variant === 'busy') {
    const radius = scale * 0.09;
    fillCircle(pixels, width, stemStart, radius, color);
    fillCircle(pixels, width, left, radius, color);
    fillCircle(pixels, width, right, radius, color);
  }

}

function createHighResolutionIcon(variant, size) {

  const supersampling = 4;
  const width = size * supersampling;
  const pixels = new Uint8Array(width * width * 4);
  const shield = [
    [0.5, 0.055],
    [0.84, 0.18],
    [0.81, 0.64],
    [0.5, 0.94],
    [0.19, 0.64],
    [0.16, 0.18],
  ];
  const outer = scalePoints(shield, width);
  const inner = scalePoints(shield, width, 0.88);
  fillPolygon(
      pixels,
      width,
      outer,
      variant === 'loading' ? COLORS.off : COLORS.outline,
  );
  if (variant === 'loading') {
    fillPolygon(pixels, width, inner, COLORS.transparent);
    drawRoute(pixels, width, COLORS.off, variant);
  } else if (variant === 'off') {
    fillPolygon(pixels, width, inner, COLORS.offInner);
    drawRoute(pixels, width, COLORS.outline, variant);
  } else {
    const fill = variant === 'external' ? COLORS.external : COLORS.active;
    fillPolygon(pixels, width, inner, fill);
    drawRoute(pixels, width, COLORS.white, variant);
  }
  if (variant === 'external') {
    drawLine(
        pixels,
        width,
        [width * 0.25, width * 0.73],
        [width * 0.75, width * 0.23],
        width * 0.12,
        COLORS.white,
    );
    drawLine(
        pixels,
        width,
        [width * 0.25, width * 0.73],
        [width * 0.75, width * 0.23],
        width * 0.055,
        COLORS.external,
    );
  }
  if (variant === 'warning') {
    fillPolygon(pixels, width, [
      [width * 0.67, width * 0.12],
      [width * 0.84, width * 0.18],
      [width * 0.82, width * 0.38],
      [width * 0.67, width * 0.29],
    ], COLORS.warning);
  }
  return {pixels, width, supersampling};

}

function downsample(source, targetSize, supersampling) {

  const target = new Uint8Array(targetSize * targetSize * 4);
  const samples = supersampling * supersampling;
  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let offsetY = 0; offsetY < supersampling; offsetY += 1) {
        for (let offsetX = 0; offsetX < supersampling; offsetX += 1) {
          const sourceX = x * supersampling + offsetX;
          const sourceY = y * supersampling + offsetY;
          const offset = (sourceY * source.width + sourceX) * 4;
          const pixelAlpha = source.pixels[offset + 3];
          alpha += pixelAlpha;
          red += source.pixels[offset] * pixelAlpha;
          green += source.pixels[offset + 1] * pixelAlpha;
          blue += source.pixels[offset + 2] * pixelAlpha;
        }
      }
      const targetOffset = (y * targetSize + x) * 4;
      target[targetOffset + 3] = Math.round(alpha / samples);
      if (alpha > 0) {
        target[targetOffset] = Math.round(red / alpha);
        target[targetOffset + 1] = Math.round(green / alpha);
        target[targetOffset + 2] = Math.round(blue / alpha);
      }
    }
  }
  return target;

}

function renderActionIcon(variant, size) {

  const source = createHighResolutionIcon(variant, size);
  return encodePng(
      size,
      size,
      downsample(source, size, source.supersampling),
  );

}

function getActionIconFileName(variant, size) {

  return `action-${variant}-${size}.png`;

}

function getExpectedActionIcons() {

  return Object.entries(VARIANT_SIZES).flatMap(([variant, sizes]) =>
    sizes.map((size) => ({
      variant,
      size,
      fileName: getActionIconFileName(variant, size),
    })),
  );

}

function writeActionIcons() {

  Fs.mkdirSync(ICON_DIRECTORY, {recursive: true});
  for (const icon of getExpectedActionIcons()) {
    Fs.writeFileSync(
        Path.join(ICON_DIRECTORY, icon.fileName),
        renderActionIcon(icon.variant, icon.size),
    );
  }

}

if (require.main === module) {
  writeActionIcons();
  console.log(
      `Generated ${getExpectedActionIcons().length} deterministic action icons.`,
  );
}

module.exports = {
  ICON_DIRECTORY,
  VARIANT_SIZES,
  getActionIconFileName,
  getExpectedActionIcons,
  renderActionIcon,
  writeActionIcons,
};
