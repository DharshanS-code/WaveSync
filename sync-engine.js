/**
 * WaveSync sync engine — vanilla JS, zero dependencies.
 *
 * - Automatic discovery: every device that opens the app on the same network
 *   announces itself and is auto-joined. No room codes, ever.
 * - Unique session user id per browser tab/device (persisted per session).
 * - Host is elected automatically (first device online, lowest id wins ties).
 * - Guests cannot load or control a track without host permission.
 * - Shared GMT-style clock (NTP handshake) + a 0.5 s drifter that nudges
 *   playbackRate or hard-seeks.
 *
 * Transport: a LAN WebSocket relay at `/ws` (provided by server.js over WiFi),
 * otherwise BroadcastChannel for same-browser devices/tabs.
 */

/* global window, BroadcastChannel, WebSocket, crypto, Date, setInterval, clearTimeout, setTimeout, clearInterval, sessionStorage */

var DRIFT_TICK_MS = 500;
var DEADBAND_MS = 10;
var SEEK_THRESHOLD_MS = 60;
var DISCOVERY_MS = 1200;
var CHANNEL = "wavesync-lan";

function sessionId() {
  if (typeof sessionStorage !== "undefined") {
    var existing = sessionStorage.getItem("wavesync:uid");
    if (existing) return existing;
  }
  var id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  try {
    sessionStorage.setItem("wavesync:uid", id);
  } catch (e) {
    /* ignore */
  }
  return id;
}

/**
 * @param {object} opts
 * @param {string} opts.name
 * @param {function} opts.audio  - returns HTMLAudioElement | null
 * @param {function} opts.onState - callback receiving EngineState
 */
function SyncEngine(opts) {
  this.opts = opts;
  this.id = sessionId();
  this.role = "idle";            // idle | host | guest
  this.transport = "local";      // lan | local
  this.clockOffset = 0;
  this.samples = [];
  this.drift = 0;
  this.corrections = 0;
  this.hostTrack = null;
  this.peers = new Map();
  this.requests = new Map();
  this.granted = new Set();
  this.canUpload = false;
  this.timers = [];
  this.discovery = null;
  this.lastBeat = null;
  this.ch = null;
  this.ws = null;
}

SyncEngine.prototype.now = function () {
  return Date.now() + this.clockOffset;
};

SyncEngine.prototype.emit = function () {
  var self = this;
  this.opts.onState({
    selfId: this.id,
    role: this.role,
    network: this.transport === "lan" ? "Wi-Fi network" : "This device",
    transport: this.transport,
    peers: Array.from(this.peers.values())
      .map(function (p) {
        return Object.assign({}, p, { canUpload: self.granted.has(p.id) });
      })
      .sort(function (a, b) {
        return Number(b.host) - Number(a.host) || a.name.localeCompare(b.name);
      }),
    requests: Array.from(this.requests).map(function (e) {
      return { id: e[0], name: e[1] };
    }),
    canUpload: this.role === "host" || this.canUpload,
    drift: this.drift,
    offset: this.clockOffset,
    hostTrack: this.hostTrack,
    corrections: this.corrections,
  });
};

SyncEngine.prototype.send = function (m) {
  var raw = JSON.stringify(m);
  if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(raw);
  if (this.ch) this.ch.postMessage(m);
};

/** Auto-connect: open transports, listen, elect a role. No user input. */
SyncEngine.prototype.start = function () {
  this.stop(false);

  var self = this;
  try {
    this.ch = new BroadcastChannel(CHANNEL);
    this.ch.onmessage = function (e) {
      self.handle(e.data);
    };
  } catch (e) {
    this.ch = null;
  }

  if (typeof location !== "undefined" && location.protocol.indexOf("http") === 0) {
    try {
      var proto = location.protocol === "https:" ? "wss" : "ws";
      var url = proto + "://" + location.host + "/ws";
      var ws = new WebSocket(url);
      ws.onopen = function () {
        self.ws = ws;
        self.transport = "lan";
        self.send({ t: "hello", from: self.id, name: self.opts.name });
        self.emit();
      };
      ws.onmessage = function (e) {
        try {
          self.handle(JSON.parse(String(e.data)));
        } catch (err) {
          /* ignore */
        }
      };
      ws.onclose = function () {
        if (self.ws === ws) {
          self.ws = null;
          self.transport = "local";
          self.emit();
        }
      };
      ws.onerror = function () {
        ws.close();
      };
    } catch (e) {
      /* no relay available — BroadcastChannel only */
    }
  }

  this.send({ t: "hello", from: this.id, name: this.opts.name });
  this.discovery = setTimeout(function () {
    if (self.role === "idle") self.becomeHost();
  }, DISCOVERY_MS);

  this.timers.push(setInterval(function () {
    self.prunePeers();
  }, 2000));
  this.timers.push(setInterval(function () {
    self.loop();
  }, DRIFT_TICK_MS));
  this.timers.push(setInterval(function () {
    if (self.role === "guest") self.handshake();
    self.send({ t: "hello", from: self.id, name: self.opts.name });
  }, 3000));

  this.emit();
};

SyncEngine.prototype.stop = function (announce) {
  if (announce === undefined) announce = true;
  if (announce) this.send({ t: "bye", from: this.id });
  this.timers.forEach(clearInterval);
  this.timers = [];
  if (this.discovery) clearTimeout(this.discovery);
  this.discovery = null;
  if (this.ch) {
    this.ch.close();
    this.ch = null;
  }
  if (this.ws) {
    this.ws.close();
    this.ws = null;
  }
  this.role = "idle";
  this.peers.clear();
  this.requests.clear();
  this.granted.clear();
  this.canUpload = false;
  this.drift = 0;
  if (announce) this.emit();
};

SyncEngine.prototype.becomeHost = function () {
  this.role = "host";
  this.clockOffset = 0;
  this.drift = 0;
  this.send({ t: "here", from: this.id, name: this.opts.name });
  this.emit();
};

SyncEngine.prototype.becomeGuest = function () {
  if (this.role === "guest") return;
  this.role = "guest";
  this.corrections = 0;
  if (this.discovery) clearTimeout(this.discovery);
  this.handshake();
  this.emit();
};

/** Granted guest takes over playback (host handed the aux cable across). */
SyncEngine.prototype.promote = function () {
  if (this.role === "host" || !this.canUpload) return;
  this.becomeHost();
};

SyncEngine.prototype.setTrack = function (name) {
  this.hostTrack = name;
  this.emit();
};

/** Guest asks the host for permission to load and play a track. */
SyncEngine.prototype.requestUpload = function () {
  this.send({ t: "req", from: this.id, name: this.opts.name });
};

/** Host answers a pending request. */
SyncEngine.prototype.respond = function (peerId, allow) {
  if (this.role !== "host") return;
  if (allow) this.granted.add(peerId);
  else this.granted.delete(peerId);
  this.requests.delete(peerId);
  this.send({ t: "perm", from: this.id, to: peerId, allow: allow });
  this.emit();
};

SyncEngine.prototype.revoke = function (peerId) {
  this.respond(peerId, false);
};

SyncEngine.prototype.prunePeers = function () {
  var cutoff = Date.now() - 8000;
  var changed = false;
  this.peers.forEach(function (p, k) {
    if (p.at < cutoff) {
      this.peers.delete(k);
      this.requests.delete(k);
      this.granted.delete(k);
      changed = true;
    }
  }.bind(this));
  // Host vanished -> re-elect.
  if (this.role === "guest") {
    var hasHost = false;
    this.peers.forEach(function (p) {
      if (p.host) hasHost = true;
    });
    if (!hasHost) {
      var ids = [this.id].concat(Array.from(this.peers.keys())).sort();
      if (ids[0] === this.id) this.becomeHost();
      changed = true;
    }
  }
  if (changed) this.emit();
};

SyncEngine.prototype.handshake = function () {
  this.send({ t: "ping", from: this.id, t1: Date.now() });
};

SyncEngine.prototype.loop = function () {
  if (this.role === "host") this.beat();
  else if (this.role === "guest") this.tick();
};

SyncEngine.prototype.beat = function () {
  var a = this.opts.audio();
  if (!a) return;
  this.send({
    t: "beat",
    from: this.id,
    name: this.opts.name,
    track: this.hostTrack,
    position: a.currentTime * 1000,
    atGmt: this.now(),
    playing: !a.paused,
  });
};

/** The 0.5 s auto drifter. */
SyncEngine.prototype.tick = function () {
  var a = this.opts.audio();
  var beat = this.lastBeat;
  if (!a || !beat) return;

  if (!beat.playing) {
    if (!a.paused) a.pause();
    this.drift = 0;
    this.emit();
    return;
  }
  if (a.paused && a.src) {
    var self = this;
    a.play().catch(function () {});
  }

  var expected = beat.position + (this.now() - beat.atGmt);
  var d = a.currentTime * 1000 - expected;
  this.drift = d;

  var abs = Math.abs(d);
  if (abs > SEEK_THRESHOLD_MS) {
    a.currentTime = Math.max(0, expected / 1000);
    a.playbackRate = 1;
    this.corrections++;
  } else if (abs > DEADBAND_MS) {
    a.playbackRate = d > 0 ? 0.998 : 1.002;
  } else {
    a.playbackRate = 1;
  }

  this.send({
    t: "state",
    from: this.id,
    name: this.opts.name,
    drift: d,
    ready: a.readyState >= 3,
  });
  this.emit();
};

SyncEngine.prototype.touch = function (id, name, host) {
  var prev = this.peers.get(id);
  this.peers.set(id, {
    id: id,
    name: name,
    drift: prev ? prev.drift : 0,
    ready: prev ? prev.ready : false,
    host: host,
    canUpload: this.granted.has(id),
    at: Date.now(),
  });
};

SyncEngine.prototype.handle = function (m) {
  if (m.from === this.id) return;
  var self = this;

  switch (m.t) {
    case "hello":
      this.touch(m.from, m.name, (this.peers.get(m.from) || {}).host || false);
      if (this.role === "host")
        this.send({ t: "here", from: this.id, name: this.opts.name, to: m.from });
      this.emit();
      break;

    case "here":
      this.touch(m.from, m.name, true);
      if (this.role !== "host") this.becomeGuest();
      else if (m.from < this.id) {
        // Two hosts met: lowest id keeps the crown.
        this.becomeGuest();
      }
      this.emit();
      break;

    case "ping":
      if (this.role === "host")
        this.send({ t: "pong", from: this.id, to: m.from, t1: m.t1, t2: Date.now(), t3: Date.now() });
      break;

    case "pong":
      if (m.to !== this.id) return;
      var t4 = Date.now();
      var offset = (m.t2 - m.t1 + (m.t3 - t4)) / 2;
      this.samples.push(offset);
      if (this.samples.length > 7) this.samples.shift();
      var sorted = this.samples.slice().sort(function (a, b) {
        return a - b;
      });
      this.clockOffset = sorted[Math.floor(sorted.length / 2)] || 0;
      this.emit();
      break;

    case "beat":
      this.touch(m.from, m.name, true);
      if (this.role !== "host") {
        this.becomeGuest();
        this.lastBeat = { position: m.position, atGmt: m.atGmt, playing: m.playing };
        this.hostTrack = m.track;
      }
      this.emit();
      break;

    case "state":
      this.touch(m.from, m.name, (this.peers.get(m.from) || {}).host || false);
      var p = this.peers.get(m.from);
      if (p) {
        p.drift = m.drift;
        p.ready = m.ready;
      }
      this.emit();
      break;

    case "req":
      if (this.role === "host") {
        this.requests.set(m.from, m.name);
        this.touch(m.from, m.name, false);
        this.emit();
      }
      break;

    case "perm":
      if (m.to === this.id) {
        this.canUpload = m.allow;
        this.emit();
      }
      break;

    case "bye":
      this.peers.delete(m.from);
      this.requests.delete(m.from);
      this.granted.delete(m.from);
      this.emit();
      break;
  }
};

// Export for both module and browser-global contexts.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SyncEngine: SyncEngine,
    DRIFT_TICK_MS: DRIFT_TICK_MS,
    DEADBAND_MS: DEADBAND_MS,
    SEEK_THRESHOLD_MS: SEEK_THRESHOLD_MS,
  };
}
if (typeof window !== "undefined") {
  window.SyncEngine = SyncEngine;
}
