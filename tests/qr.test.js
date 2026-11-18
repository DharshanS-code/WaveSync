import test from 'node:test';
import assert from 'node:assert/strict';
import { QR_LIMITS, qrMatrix, qrSvg } from '../src/qr.js';

function unmask(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    default: throw new Error('Invalid mask');
  }
}

// Independent specification fixtures, not a copy of the encoder's spacing calculation.
const ALIGNMENT_POSITIONS = [[], [], [6,18], [6,22], [6,26], [6,30], [6,34],
  [6,22,38], [6,24,42], [6,26,46], [6,28,50], [6,30,54], [6,32,58],
  [6,34,62], [6,26,46,66], [6,26,48,70], [6,26,50,74], [6,30,54,78],
  [6,30,56,82], [6,30,58,86], [6,34,62,90]];
function alignmentPositions(version) { return ALIGNMENT_POSITIONS[version]; }

function reservedModules(version) {
  const size = version * 4 + 17;
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));
  const mark = (x, y) => {
    if (x >= 0 && x < size && y >= 0 && y < size) reserved[y][x] = true;
  };
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  }
  const positions = alignmentPositions(version);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === positions.length - 1) ||
          (i === positions.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(positions[i] + dx, positions[j] + dy);
    }
  }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + i % 3;
      const b = Math.floor(i / 3);
      mark(a, b); mark(b, a);
    }
  }
  return reserved;
}

const ECC_CODEWORDS_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26,
  30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
];
const ERROR_CORRECTION_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
  5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
];

function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function deinterleaveData(codewords, version) {
  const blockCount = ERROR_CORRECTION_BLOCKS[version];
  const eccLength = ECC_CODEWORDS_PER_BLOCK[version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlockCount = blockCount - rawCodewords % blockCount;
  const shortDataLength = Math.floor(rawCodewords / blockCount) - eccLength;
  const blocks = Array.from({ length: blockCount }, (_, index) =>
    new Uint8Array(shortDataLength + (index < shortBlockCount ? 0 : 1)));
  let offset = 0;
  for (let i = 0; i <= shortDataLength; i++) {
    for (let block = 0; block < blockCount; block++) {
      if (i < blocks[block].length) blocks[block][i] = codewords[offset++];
    }
  }
  return Uint8Array.from(blocks.flatMap((block) => Array.from(block)));
}

function decodeBytePayload(qr) {
  const { modules, version } = qr;
  const size = modules.length;
  let format = 0;
  const coordinates = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < coordinates.length; i++) {
    const [x, y] = coordinates[i];
    if (modules[y][x]) format |= 1 << i;
  }
  const encoded = format ^ 0x5412;
  const mask = (encoded >>> 10) & 7;
  assert.equal((encoded >>> 13) & 3, 0, 'format specifies ECC M');

  const reserved = reservedModules(version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let vertical = 0; vertical < size; vertical++) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset++) {
        const x = right - offset;
        if (!reserved[y][x]) bits.push(Number(modules[y][x] !== unmask(mask, x, y)));
      }
    }
  }
  const codewords = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < codewords.length; i++) {
    codewords[i] = bits.slice(i * 8, i * 8 + 8).reduce((value, bit) => value * 2 + bit, 0);
  }
  const data = deinterleaveData(codewords, version);
  const dataBits = Array.from(data).flatMap((byte) =>
    Array.from({ length: 8 }, (_, index) => (byte >>> (7 - index)) & 1));
  const read = (start, length) => dataBits.slice(start, start + length).reduce((value, bit) => value * 2 + bit, 0);
  assert.equal(read(0, 4), 4, 'byte mode indicator');
  const countBits = version <= 9 ? 8 : 16;
  const length = read(4, countBits);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = read(4 + countBits + i * 8, 8);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function assertFinder(matrix, originX, originY) {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const expected = x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
      assert.equal(matrix[originY + y][originX + x], expected);
    }
  }
}

test('encodes the ISO QR symbol structure and round-trips ASCII bytes', () => {
  const text = 'https://wavesync.example/?room=ABCD1234';
  const qr = qrMatrix(text);
  assert.equal(qr.version, 3);
  assert.equal(qr.modules.length, 29);
  assertFinder(qr.modules, 0, 0);
  assertFinder(qr.modules, 22, 0);
  assertFinder(qr.modules, 0, 22);
  assert.equal(decodeBytePayload(qr), text);
});

test('round-trips multibyte UTF-8 and selects a bounded higher version', () => {
  const text = `upi://pay?pa=dharshandcu@nyes&pn=${'Wave Sync ₹ '.repeat(28)}`;
  const byteLength = new TextEncoder().encode(text).length;
  assert.ok(byteLength > 250);
  const qr = qrMatrix(text);
  assert.ok(qr.version >= 10 && qr.version <= QR_LIMITS.maxVersion);
  assert.equal(decodeBytePayload(qr), text);
});

test('supports the documented maximum byte count and rejects overflow', () => {
  assert.equal(QR_LIMITS.maxPayloadBytes, 666);
  assert.doesNotThrow(() => qrMatrix('x'.repeat(QR_LIMITS.maxPayloadBytes)));
  assert.throws(() => qrMatrix('x'.repeat(QR_LIMITS.maxPayloadBytes + 1)), /too large/);
});

test('renders safe self-contained SVG with a four-module quiet zone', () => {
  const malicious = '"><script>alert(1)</script>&';
  const svg = qrSvg(malicious);
  const qr = qrMatrix(malicious);
  const dimension = qr.modules.length + QR_LIMITS.quietZoneModules * 2;
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(svg.includes(`viewBox="0 0 ${dimension} ${dimension}"`));
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.ok(!svg.includes(malicious));
  assert.ok(!svg.includes('<script'));
});

test('version 7 uses specification alignment centers, independent of encoder arithmetic', () => {
  const qr = qrMatrix('x'.repeat(107));
  assert.equal(qr.version, 7);
  for (const cy of [6,22,38]) for (const cx of [6,22,38]) {
    if ((cx === 6 && cy === 6) || (cx === 38 && cy === 6) || (cx === 6 && cy === 38)) continue;
    for (let dy=-2;dy<=2;dy++) for (let dx=-2;dx<=2;dx++) {
      assert.equal(qr.modules[cy+dy][cx+dx], Math.max(Math.abs(dx),Math.abs(dy)) !== 1, `center ${cx},${cy} offset ${dx},${dy}`);
    }
  }
  assert.equal(decodeBytePayload(qr), 'x'.repeat(107));
});

test('validates payload type', () => {
  assert.throws(() => qrSvg(null), TypeError);
  assert.throws(() => qrMatrix(123), TypeError);
});
