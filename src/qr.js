// Dependency-free QR Code encoder for WaveSync room invites and payment intents.
// Encodes UTF-8 byte mode with error correction level M, QR versions 1–20.

const MIN_VERSION = 1;
const MAX_VERSION = 20;
const QUIET_ZONE = 4;
const ECC_CODEWORDS_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26,
  30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
];
const ERROR_CORRECTION_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
  5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
];

function appendBits(value, length, output) {
  if (!Number.isInteger(value) || value < 0 || value >>> length !== 0) {
    throw new RangeError('Bit value does not fit the requested length.');
  }
  for (let i = length - 1; i >= 0; i--) output.push((value >>> i) & 1);
}

function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version) {
  return Math.floor(rawDataModules(version) / 8)
    - ECC_CODEWORDS_PER_BLOCK[version] * ERROR_CORRECTION_BLOCKS[version];
}

function chooseVersion(byteLength) {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    const countBits = version <= 9 ? 8 : 16;
    if (byteLength < 2 ** countBits && 4 + countBits + byteLength * 8 <= dataCodewords(version) * 8) {
      return version;
    }
  }
  throw new RangeError(`QR payload is too large; UTF-8 byte mode is limited to ${maxPayloadBytes()} bytes.`);
}

function maxPayloadBytes() {
  return Math.floor((dataCodewords(MAX_VERSION) * 8 - 4 - 16) / 8);
}

function reedSolomonDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = multiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = multiply(root, 2);
  }
  return result;
}

function reedSolomonRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= multiply(divisor[i], factor);
  }
  return result;
}

function multiply(x, y) {
  let result = 0;
  for (let i = 7; i >= 0; i--) {
    result = (result << 1) ^ ((result >>> 7) * 0x11D);
    result ^= ((y >>> i) & 1) * x;
  }
  return result;
}

function makeDataCodewords(bytes, version) {
  const capacity = dataCodewords(version) * 8;
  const bits = [];
  appendBits(0x4, 4, bits);
  appendBits(bytes.length, version <= 9 ? 8 : 16, bits);
  for (const byte of bytes) appendBits(byte, 8, bits);
  appendBits(0, Math.min(4, capacity - bits.length), bits);
  while (bits.length % 8) bits.push(0);

  const result = [];
  for (let i = 0; i < bits.length; i += 8) {
    result.push(bits.slice(i, i + 8).reduce((value, bit) => value * 2 + bit, 0));
  }
  for (let pad = 0xEC; result.length < dataCodewords(version); pad ^= 0xEC ^ 0x11) result.push(pad);
  return Uint8Array.from(result);
}

function addErrorCorrectionAndInterleave(data, version) {
  const blockCount = ERROR_CORRECTION_BLOCKS[version];
  const eccLength = ECC_CODEWORDS_PER_BLOCK[version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlockCount = blockCount - rawCodewords % blockCount;
  const shortBlockLength = Math.floor(rawCodewords / blockCount);
  const blocks = [];
  const divisor = reedSolomonDivisor(eccLength);
  let offset = 0;

  for (let block = 0; block < blockCount; block++) {
    const dataLength = shortBlockLength - eccLength + (block < shortBlockCount ? 0 : 1);
    const chunk = data.slice(offset, offset + dataLength);
    offset += dataLength;
    blocks.push({ data: chunk, ecc: reedSolomonRemainder(chunk, divisor) });
  }

  const result = [];
  const maxDataLength = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < maxDataLength; i++) {
    for (const block of blocks) if (i < block.data.length) result.push(block.data[i]);
  }
  for (let i = 0; i < eccLength; i++) {
    for (const block of blocks) result.push(block.ecc[i]);
  }
  return Uint8Array.from(result);
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = version * 4 + 10; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    default: throw new RangeError('QR mask must be from 0 to 7.');
  }
}

function buildMatrix(codewords, version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const functions = Array.from({ length: size }, () => Array(size).fill(false));
  const setFunction = (x, y, dark) => {
    modules[y][x] = dark;
    functions[y][x] = true;
  };

  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          setFunction(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
  };

  const drawAlignment = (cx, cy) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  };

  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  const positions = alignmentPositions(version);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === positions.length - 1) ||
          (i === positions.length - 1 && j === 0)) continue;
      drawAlignment(positions[i], positions[j]);
    }
  }

  const drawFormat = (mask) => {
    const data = (0 << 3) | mask; // Error correction M has format indicator 00.
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (index) => ((bits >>> index) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFunction(8, i, bit(i));
    setFunction(8, 7, bit(6));
    setFunction(8, 8, bit(7));
    setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, bit(i));
    setFunction(8, size - 8, true);
  };
  drawFormat(0);

  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1F25);
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, dark);
      setFunction(b, a, dark);
    }
  }

  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let vertical = 0; vertical < size; vertical++) {
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset++) {
        const x = right - offset;
        if (!functions[y][x] && bitIndex < codewords.length * 8) {
          modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex++;
        }
      }
    }
  }
  if (bitIndex !== codewords.length * 8) throw new Error('QR data placement failed.');

  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, functions, mask);
    drawFormat(mask);
    const penalty = matrixPenalty(modules);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    applyMask(modules, functions, mask);
    drawFormat(0);
  }
  applyMask(modules, functions, bestMask);
  drawFormat(bestMask);
  return modules;
}

function applyMask(modules, functions, mask) {
  for (let y = 0; y < modules.length; y++) {
    for (let x = 0; x < modules.length; x++) if (!functions[y][x] && maskBit(mask, x, y)) modules[y][x] = !modules[y][x];
  }
}

function matrixPenalty(modules) {
  const size = modules.length;
  let result = 0;
  const scoreLine = (line) => {
    let score = 0;
    let run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
    const text = line.map(Number).join('');
    for (let i = 0; i + 6 < text.length; i++) {
      if (text.slice(i, i + 7) === '1011101') {
        const before = i < 4 || text.slice(i - 4, i) === '0000';
        const after = i + 11 > text.length || text.slice(i + 7, i + 11) === '0000';
        if (before || after) score += 40;
      }
    }
    return score;
  };
  for (let i = 0; i < size; i++) {
    result += scoreLine(modules[i]);
    result += scoreLine(modules.map((row) => row[i]));
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const value = modules[y][x];
      if (value === modules[y][x + 1] && value === modules[y + 1][x] && value === modules[y + 1][x + 1]) result += 3;
    }
  }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  result += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return result;
}

/**
 * Encodes text as a standards-compliant QR matrix (ECC M, versions 1–20).
 * The returned object is useful for canvas/native renderers; do not mutate `modules`.
 */
export function qrMatrix(text) {
  if (typeof text !== 'string') throw new TypeError('QR payload must be a string.');
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const data = makeDataCodewords(bytes, version);
  return Object.freeze({
    version,
    errorCorrection: 'M',
    quietZone: QUIET_ZONE,
    modules: buildMatrix(addErrorCorrectionAndInterleave(data, version), version),
  });
}

/**
 * Returns a self-contained, high-contrast SVG QR Code. Payload bytes are encoded
 * into modules and are never interpolated into the SVG markup.
 */
export function qrSvg(text) {
  const qr = qrMatrix(text);
  const dimension = qr.modules.length + QUIET_ZONE * 2;
  const commands = [];
  for (let y = 0; y < qr.modules.length; y++) {
    for (let x = 0; x < qr.modules.length; x++) {
      if (qr.modules[y][x]) commands.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" role="img" aria-label="QR code" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${dimension}v${dimension}H0z"/><path fill="#000" d="${commands.join('')}"/></svg>`;
}

export const QR_LIMITS = Object.freeze({
  encoding: 'UTF-8 byte mode',
  errorCorrection: 'M',
  minVersion: MIN_VERSION,
  maxVersion: MAX_VERSION,
  maxPayloadBytes: maxPayloadBytes(),
  quietZoneModules: QUIET_ZONE,
});
