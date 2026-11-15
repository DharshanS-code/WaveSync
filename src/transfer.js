// Reliable, bounded file transfer over one ordered RTCDataChannel.

export const TRANSFER_LIMITS = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxFrameBytes: 64 * 1024,
  chunkBytes: 16 * 1024,
  highWaterBytes: 1024 * 1024,
  lowWaterBytes: 256 * 1024,
  maxQueued: 2,
  drainTimeoutMs: 30_000
});

const textEncoder = new TextEncoder();
const randomId = () => globalThis.crypto?.randomUUID?.()
  || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function eventWithDetail(type, detail) {
  if (typeof CustomEvent === 'function') return new CustomEvent(type, { detail });
  const event = new Event(type);
  Object.defineProperty(event, 'detail', { value: detail, enumerable: true });
  return event;
}

function byteLength(value) {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return -1;
}

function bytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function validNumber(value, minimum = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}

function validIdentity(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Validate the identity and bounded metadata carried by a file header. */
export function validTransferMeta(meta, size = meta?.size, maxBytes = TRANSFER_LIMITS.maxFileBytes) {
  return !!meta && typeof meta === 'object' && !Array.isArray(meta)
    && validIdentity(meta.trackId)
    && (validIdentity(meta.epoch) || validNumber(meta.epoch))
    && validIdentity(meta.name, 1024)
    && validIdentity(meta.mime, 255)
    && validNumber(size) && Number.isSafeInteger(size) && size <= maxBytes
    && validNumber(meta.duration);
}

function normalizeMeta(meta, size) {
  return {
    trackId: meta.trackId,
    epoch: meta.epoch,
    name: meta.name,
    mime: meta.mime,
    size,
    duration: meta.duration,
    ...(typeof meta.sha256 === 'string' ? { sha256: meta.sha256 } : {})
  };
}

function listen(target, type, fn) {
  if (typeof target?.addEventListener === 'function') {
    target.addEventListener(type, fn);
    return () => target.removeEventListener?.(type, fn);
  }
  const key = `on${type}`;
  const previous = target?.[key];
  const wrapper = (event) => { previous?.call(target, event); fn(event); };
  if (target) target[key] = wrapper;
  return () => { if (target && target[key] === wrapper) target[key] = previous || null; };
}

/**
 * A transfer endpoint for a single reliable, ordered data channel. Sending is
 * serialized; receiving permits exactly one announced transfer at a time.
 */
export class DataChannelTransfer extends EventTarget {
  constructor(channel, cfg = {}) {
    super();
    this.channel = channel;
    this.cfg = cfg;
    this.networkQuality = cfg.networkQuality || null;
    const profile = this.networkQuality?.profile?.() || {};
    this.chunkBytes = cfg.chunkSize || TRANSFER_LIMITS.chunkBytes;
    this.maxFileBytes = cfg.maxEncodedBytes || TRANSFER_LIMITS.maxFileBytes;
    this.highWaterBytes = profile.maxBufferedBytes || cfg.transferHighWaterBytes || TRANSFER_LIMITS.highWaterBytes;
    this.lowWaterBytes = Math.min(cfg.transferLowWaterBytes || TRANSFER_LIMITS.lowWaterBytes, this.highWaterBytes);
    this.maxQueued = cfg.maxTransferQueue ?? TRANSFER_LIMITS.maxQueued;
    this.timeoutMs = profile.transferTimeoutMs || cfg.transferTimeoutMs || TRANSFER_LIMITS.drainTimeoutMs;
    this._queue = [];
    this._activeSend = null;
    this._recv = null;
    this._closed = false;
    this._drains = new Set();
    this._receiveChain = Promise.resolve();
    this._receiveQueue = [];
    this._queuedReceiveBytes = 0;
    this._receiving = false;
    this._unlisten = [
      listen(channel, 'message', (event) => {
        const data = event.data;
        const size = typeof data === 'string' ? textEncoder.encode(data).byteLength : byteLength(data);
        if (this._closed) return;
        if (size < 0 || this._receiveQueue.length >= 4096 ||
            this._queuedReceiveBytes + size > this.maxFileBytes + 2 * TRANSFER_LIMITS.maxFrameBytes) {
          this._receiveError('Pending transfer frames exceeded memory budget');
          this.close(new Error('Receive queue overflow'));
          return;
        }
        this._receiveQueue.push({ data, size });
        this._queuedReceiveBytes += size;
        if (!this._receiving) this._receiveChain = this._consumeReceiveQueue();
      }),
      listen(channel, 'close', () => this.close(new Error('Data channel closed'))),
      listen(channel, 'error', () => this.close(new Error('Data channel error')))
    ];
    try { channel.binaryType = 'arraybuffer'; } catch {}
    try { channel.bufferedAmountLowThreshold = this.lowWaterBytes; } catch {}
  }

  _emit(type, detail) {
    this.dispatchEvent(eventWithDetail(type, detail));
  }

  /** Resolve after the complete header/body/EOF sequence has been handed off. */
  sendFile(arrayBuffer, meta) {
    const view = bytes(arrayBuffer);
    if (!view) return Promise.reject(new TypeError('File must be an ArrayBuffer or typed array'));
    if (!validTransferMeta(meta, view.byteLength, this.maxFileBytes)) {
      return Promise.reject(new RangeError('Invalid file metadata or size'));
    }
    if (this._closed) return Promise.reject(new Error('Transfer endpoint is closed'));
    if (this._activeSend && this._queue.length >= this.maxQueued) {
      return Promise.reject(new Error('Transfer queue is full'));
    }

    return new Promise((resolve, reject) => {
      this._queue.push({
        buffer: view.slice(),
        meta: normalizeMeta(meta, view.byteLength),
        transferId: randomId(),
        resolve,
        reject
      });
      this._pump();
    });
  }

  async _pump() {
    if (this._activeSend || this._closed) return;
    const job = this._queue.shift();
    if (!job) return;
    this._activeSend = job;
    try {
      this._assertOpen();
      const startedAt = performance.now();
      let stalledMs = 0;
      this._sendText({ kind: 'file-header', transferId: job.transferId, ...job.meta });
      for (let offset = 0; offset < job.buffer.byteLength; offset += this.chunkBytes) {
        this._assertOpen();
        if ((this.channel.bufferedAmount || 0) > this.highWaterBytes) {
          const stalledAt = performance.now();
          await this._drain();
          stalledMs += performance.now() - stalledAt;
        }
        this._assertOpen();
        this.channel.send(job.buffer.subarray(offset, Math.min(offset + this.chunkBytes, job.buffer.byteLength)));
      }
      this._assertOpen();
      this._sendText({ kind: 'file-eof', transferId: job.transferId });
      this.networkQuality?.delivery?.({
        bytes: job.buffer.byteLength,
        durationMs: performance.now() - startedAt,
        stalledMs
      });
      job.resolve({ transferId: job.transferId, meta: job.meta });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (this._activeSend === job) this._activeSend = null;
      job.reject(failure);
      this.close(failure);
    } finally {
      if (this._activeSend === job) this._activeSend = null;
      this._pump();
    }
  }

  _assertOpen() {
    if (this._closed || this.channel?.readyState !== 'open') throw new Error('Data channel is not open');
  }

  _sendText(message) {
    const encoded = JSON.stringify(message);
    if (textEncoder.encode(encoded).byteLength > TRANSFER_LIMITS.maxFrameBytes) {
      throw new RangeError('Transfer control frame is too large');
    }
    this.channel.send(encoded);
  }

  _drain() {
    if ((this.channel.bufferedAmount || 0) <= this.lowWaterBytes) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.channel.removeEventListener?.('bufferedamountlow', onLow);
        this.channel.removeEventListener?.('close', onClose);
        this.channel.removeEventListener?.('error', onError);
        this._drains.delete(cancel);
        error ? reject(error) : resolve();
      };
      const onLow = () => finish();
      const onClose = () => finish(new Error('Data channel closed while draining'));
      const onError = () => finish(new Error('Data channel failed while draining'));
      const cancel = (error) => finish(error || new Error('Transfer cancelled'));
      const timer = setTimeout(() => finish(new Error('Data channel drain timed out')), this.timeoutMs);
      this._drains.add(cancel);
      this.channel.addEventListener?.('bufferedamountlow', onLow, { once: true });
      this.channel.addEventListener?.('close', onClose, { once: true });
      this.channel.addEventListener?.('error', onError, { once: true });
    });
  }

  async _consumeReceiveQueue() {
    this._receiving = true;
    try {
      while (!this._closed && this._receiveQueue.length) {
        const frame = this._receiveQueue.shift();
        this._queuedReceiveBytes -= frame.size;
        try { await this._onMessage(frame.data); }
        catch (error) { this._receiveError(error?.message || 'Transfer receive failed'); }
      }
    } finally { this._receiving = false; }
  }

  async _onMessage(data) {
    if (this._closed) return;
    if (typeof data === 'string') {
      if (textEncoder.encode(data).byteLength > TRANSFER_LIMITS.maxFrameBytes) {
        this._receiveError('Transfer control frame is too large');
        return;
      }
      let message;
      try { message = JSON.parse(data); } catch {
        this._receiveError('Malformed transfer control frame');
        return;
      }
      if (message?.kind === 'file-header') this._onHeader(message);
      else if (message?.kind === 'file-eof') await this._onEof(message);
      else this._receiveError('Unknown transfer control frame');
      return;
    }

    const length = byteLength(data);
    if (length < 0) {
      this._receiveError('Unsupported transfer frame');
      return;
    }
    if (!this._recv) {
      this._receiveError('Binary data arrived before a file header');
      return;
    }
    if (length <= 0 || length > this.chunkBytes || this._recv.received + length > this._recv.meta.size) {
      this._receiveError('Transfer exceeded its announced size');
      return;
    }
    const chunk = bytes(data);
    this._recv.output.set(chunk, this._recv.received);
    this._recv.received += length;
    const { meta, received } = this._recv;
    this._emit('file-progress', {
      trackId: meta.trackId,
      received,
      size: meta.size,
      ratio: meta.size === 0 ? 1 : received / meta.size
    });
  }

  _onHeader(message) {
    if (this._recv) {
      this._receiveError('A transfer is already in progress');
      return;
    }
    if (!validIdentity(message.transferId) || !validTransferMeta(message, message.size, this.maxFileBytes)) {
      this._receiveError('Invalid file header');
      return;
    }
    const meta = normalizeMeta(message, message.size);
    this._recv = { transferId: message.transferId, meta, received: 0, output: new Uint8Array(meta.size) };
    this._emit('file-start', { meta });
  }

  async _onEof(message) {
    const recv = this._recv;
    if (!recv || !validIdentity(message?.transferId) || message.transferId !== recv.transferId) {
      this._receiveError('Unexpected file EOF');
      return;
    }
    if (recv.received !== recv.meta.size) {
      this._receiveError('Transfer ended before its announced size');
      return;
    }
    this._recv = null;
    const output = recv.output;
    if (recv.meta.sha256) {
      const valid = await this._verifyDigest(output, recv.meta.sha256);
      if (this._closed) return;
      if (!valid) {
        this._emit('transfer-error', { message: 'Transfer checksum mismatch', trackId: recv.meta.trackId });
        return;
      }
    }
    if (!this._closed) this._emit('file-done', { buffer: output.buffer, meta: recv.meta });
  }

  async _verifyDigest(data, expected) {
    try {
      if (!globalThis.crypto?.subtle) return false;
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
      const hex = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
      let binary = '';
      for (const value of digest) binary += String.fromCharCode(value);
      const base64 = typeof btoa === 'function' ? btoa(binary) : null;
      return expected.toLowerCase() === hex || expected === base64;
    } catch {
      return false;
    }
  }

  _receiveError(message) {
    const trackId = this._recv?.meta.trackId;
    this._recv = null;
    this._emit('transfer-error', { message, ...(trackId ? { trackId } : {}) });
  }

  close(reason = new Error('Transfer cancelled')) {
    if (this._closed) return;
    this._closed = true;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    for (const cancel of [...this._drains]) cancel(error);
    if (this._activeSend) this._activeSend.reject(error);
    for (const job of this._queue.splice(0)) job.reject(error);
    this._activeSend = null;
    this._recv = null;
    this._receiveQueue = [];
    this._queuedReceiveBytes = 0;
    for (const remove of this._unlisten.splice(0)) remove();
  }
}
