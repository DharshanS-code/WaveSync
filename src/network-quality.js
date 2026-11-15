// Browser hints are coarse estimates, never Wi-Fi hardware measurements.
export class NetworkQuality extends EventTarget {
  constructor(nav = globalThis.navigator) {
    super();
    this.connection = nav?.connection || nav?.mozConnection || nav?.webkitConnection;
    this.samples = [];
    this.p2p = null;
    this.interrupted = false;
    this._change = () => this.dispatchEvent(new Event('change'));
    this.connection?.addEventListener?.('change', this._change);
  }
  capabilities() {
    const c = this.connection;
    return {
      browserHints: !!c,
      effectiveType: typeof c?.effectiveType === 'string' ? c.effectiveType : null,
      downlinkMbps: Number.isFinite(c?.downlink) ? c.downlink : null,
      saveData: typeof c?.saveData === 'boolean' ? c.saveData : null,
      rssiDbm: null, linkSpeedMbps: null, frequencyMHz: null, band: null, channel: null,
      hardwareSource: 'unavailable in ordinary browsers',
      hintSource: c ? 'Network Information API (estimated)' : 'unavailable'
    };
  }
  delivery({ bytes, durationMs, stalledMs = 0 }) {
    if (![bytes, durationMs, stalledMs].every(Number.isFinite) || bytes <= 0 || durationMs <= 0 || stalledMs < 0) return;
    this.samples.push({ throughput: bytes * 1000 / durationMs, stallRatio: Math.min(1, stalledMs / durationMs) });
    if (this.samples.length > 8) this.samples.shift();
    this.interrupted = false;
    this._change();
  }
  peerSample({ rtt, jitter, loss }) {
    if (!Number.isFinite(rtt) || rtt < 0) return;
    this.p2p = { rtt, jitter: Number.isFinite(jitter) ? Math.max(0,jitter) : null,
      probeLoss: Number.isFinite(loss) ? Math.max(0,Math.min(1,loss)) : null };
    this._change();
  }
  setInterrupted(value) { this.interrupted = !!value; this._change(); }
  profile() {
    const hints = this.capabilities();
    const throughput = this.samples.length ? this.samples.reduce((a,s)=>a+s.throughput,0)/this.samples.length : null;
    const stalls = this.samples.length ? Math.max(...this.samples.map(s=>s.stallRatio)) : null;
    const weak = this.interrupted || (stalls !== null && stalls > .2) ||
      (throughput !== null && throughput < 128 * 1024) || (this.p2p?.jitter > 40) ||
      (this.p2p?.probeLoss > .1) || hints.saveData || ['slow-2g','2g'].includes(hints.effectiveType);
    const observedStable = this.samples.length >= 3 && throughput > 512 * 1024 && stalls < .05 &&
      this.p2p?.jitter !== null && this.p2p?.jitter < 10 && this.p2p?.probeLoss < .02;
    const mode = weak ? 'conservative' : observedStable ? 'stable' : 'unmeasured';
    return { mode, throughputBytesSec: throughput, stallRatio: stalls, hints,
      prefetchNext: !hints.saveData, maxBufferedBytes: weak ? 256 * 1024 : 1024 * 1024,
      // Safety bounds are engineering defaults, not fabricated Wi-Fi latency.
      safetyMarginSec: Math.min(.25, .02 + (this.p2p?.jitter || 0) * 3 / 1000 + (stalls || 0) * .1),
      transferTimeoutMs: weak ? 120000 : 60000,
      packetLossSource: 'telemetry probe delivery; not Wi-Fi packet loss', p2p: this.p2p };
  }
  destroy() { this.connection?.removeEventListener?.('change', this._change); }
}
