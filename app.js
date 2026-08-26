/**
 * WaveSync app — UI controller, vanilla JS, zero dependencies.
 * Pairs with sync-engine.js and style.css.
 *
 * Rendering rules (important):
 *  - Controls are STATIC nodes in index.html. render() only updates text /
 *    hidden / disabled. Never rebuild them, or taps get eaten mid-render.
 *  - render() never calls back into the engine (that caused infinite
 *    recursion -> "Maximum call stack size exceeded" -> half-drawn UI).
 *  - Lists are only rebuilt when their signature changes, so the page does
 *    not twitch every 500 ms.
 *
 * Audio never leaves the device: every phone loads the same file locally and
 * the engine only aligns playback position.
 */

/* global window, document, SyncEngine, URL */

(function () {
  "use strict";

  var audio = document.getElementById("audio");
  var name = "Device " + Math.floor(10 + Math.random() * 89);
  var asked = false;
  var track = null; // { name, url }
  var playing = false;
  var pos = 0;
  var dur = 0;
  var lastPeerSig = null;
  var lastReqSig = null;

  var els = {
    deviceName: document.getElementById("deviceName"),
    deviceId: document.getElementById("deviceId"),
    statusDot: document.getElementById("statusDot"),
    statusTitle: document.getElementById("statusTitle"),
    statusSub: document.getElementById("statusSub"),
    driftValue: document.getElementById("driftValue"),
    clockOffset: document.getElementById("clockOffset"),
    bars: document.getElementById("bars"),
    artBg: document.getElementById("artBg"),
    artLetter: document.getElementById("artLetter"),
    trackName: document.getElementById("trackName"),
    trackSub: document.getElementById("trackSub"),
    progressBar: document.getElementById("progressBar"),
    curTime: document.getElementById("curTime"),
    durTime: document.getElementById("durTime"),
    fileBtn: document.getElementById("fileBtn"),
    fileBtnLabel: document.getElementById("fileBtnLabel"),
    fileInput: document.getElementById("fileInput"),
    requestBtn: document.getElementById("requestBtn"),
    playBtn: document.getElementById("playBtn"),
    reqSection: document.getElementById("reqSection"),
    reqEmpty: document.getElementById("reqEmpty"),
    reqList: document.getElementById("reqList"),
    peerList: document.getElementById("peerList"),
    peerEmpty: document.getElementById("peerEmpty"),
    statCorrections: document.getElementById("statCorrections"),
  };

  els.deviceName.textContent = name;

  var engineState = {
    selfId: "",
    role: "idle",
    network: "This device",
    transport: "local",
    peers: [],
    requests: [],
    canUpload: false,
    drift: 0,
    offset: 0,
    hostTrack: null,
    corrections: 0,
  };

  var engine = new SyncEngine({
    name: name,
    audio: function () {
      return audio;
    },
    onState: function (s) {
      engineState = s;
      render();
    },
  });

  function fmt(s) {
    if (!isFinite(s) || s < 0) return "0:00";
    var m = Math.floor(s / 60);
    var r = Math.floor(s % 60);
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  function canControl() {
    return engineState.role === "host" || engineState.canUpload;
  }

  /* ---------------- interactions (bound once) ---------------- */

  els.fileInput.addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (track && track.url) URL.revokeObjectURL(track.url);
    track = { name: file.name.replace(/\.[^.]+$/, ""), url: URL.createObjectURL(file) };
    pos = 0;
    dur = 0;
    playing = false;
    audio.src = track.url;
    audio.load();
    if (canControl()) {
      // A granted guest that loads its own track takes over playback.
      engine.promote();
      engine.setTrack(track.name);
    }
    render();
  });

  els.requestBtn.addEventListener("click", function () {
    engine.requestUpload();
    asked = true;
    render();
  });

  els.playBtn.addEventListener("click", function () {
    if (!track) return;
    if (audio.paused) audio.play().catch(function () {});
    else audio.pause();
  });

  audio.addEventListener("timeupdate", function () {
    pos = audio.currentTime;
    els.progressBar.style.width = (dur ? (pos / dur) * 100 : 0) + "%";
    els.curTime.textContent = fmt(pos);
  });
  audio.addEventListener("loadedmetadata", function () {
    dur = audio.duration;
    els.durTime.textContent = fmt(dur);
  });
  audio.addEventListener("play", function () {
    playing = true;
    render();
  });
  audio.addEventListener("pause", function () {
    playing = false;
    render();
  });

  /* ---------------- render ---------------- */

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }
  function setHidden(el, hidden) {
    if (el && el.hidden !== hidden) el.hidden = hidden;
  }

  function render() {
    var s = engineState;
    var isHost = s.role === "host";
    var isGuest = s.role === "guest";
    var idle = s.role === "idle";
    var control = isHost || s.canUpload;
    var drift = Math.abs(Math.round(s.drift));
    var listeners = s.peers.length + 1;

    if (s.canUpload) asked = false;

    setText(els.deviceId, "id " + (s.selfId.slice(0, 8) || "…"));

    /* status */
    els.statusDot.className = idle ? "dot" : "dot live";
    setText(els.statusTitle, idle ? "Scanning the network…" : "Connected · " + s.network);
    setText(
      els.statusSub,
      idle
        ? "Devices on the same Wi-Fi join automatically"
        : listeners +
            " device" +
            (listeners === 1 ? "" : "s") +
            " · you are " +
            (isHost ? "the host" : "a guest"),
    );
    var showDrift = isGuest && !!track;
    var driftCls = drift <= 10 ? "primary" : drift <= 60 ? "accent" : "destructive";
    els.driftValue.className = "mono big bold " + (showDrift ? driftCls : "muted");
    setText(els.driftValue, idle ? "—" : showDrift ? "±" + drift + " ms" : isHost ? "host" : "—");
    setText(
      els.clockOffset,
      idle ? "clock —" : "clock " + (s.offset >= 0 ? "+" : "") + Math.round(s.offset) + " ms",
    );

    /* art + track */
    els.bars.className = "bars" + (playing ? " playing" : "");
    els.artBg.className = "art-bg" + (playing ? " playing" : "");
    var displayTrack = track ? track.name : s.hostTrack;
    setText(els.artLetter, (displayTrack || "W").charAt(0).toUpperCase());
    setText(els.trackName, displayTrack || "No track selected");
    setText(
      els.trackSub,
      isGuest
        ? track
          ? "Following the host · auto-aligned every 0.5 s"
          : s.hostTrack
            ? 'Host is playing "' + s.hostTrack + '" — load the same file below'
            : "Waiting for the host to pick a track"
        : "Local file · MP3, AAC, OGG, FLAC, WAV",
    );
    els.progressBar.style.width = (dur ? (pos / dur) * 100 : 0) + "%";
    setText(els.curTime, fmt(pos));
    setText(els.durTime, fmt(dur));

    /* controls — static nodes, only state flips */
    setHidden(els.fileBtn, false);
    setText(
      els.fileBtnLabel,
      control ? (track ? "Change file" : "Choose file") : track ? "Change file" : "Load the track file",
    );
    setHidden(els.requestBtn, control || idle);
    els.requestBtn.disabled = asked;
    setText(els.requestBtn, asked ? "Waiting for host…" : "Request permission to play");
    // Guests are driven by the host's beat; only controllers press play.
    setHidden(els.playBtn, isGuest && !control);
    els.playBtn.disabled = !track;
    setText(els.playBtn, playing ? "Pause" : "Play");

    /* permission requests — host only */
    setHidden(els.reqSection, !isHost);
    if (isHost) {
      var reqSig = s.requests
        .map(function (r) {
          return r.id;
        })
        .join(",");
      if (reqSig !== lastReqSig) {
        lastReqSig = reqSig;
        els.reqList.innerHTML = "";
        s.requests.forEach(function (r) {
          els.reqList.appendChild(requestRow(r));
        });
        setHidden(els.reqEmpty, s.requests.length > 0);
      }
    }

    /* peer list */
    var peerSig =
      s.selfId +
      "|" +
      (isHost ? "h" : "g") +
      "|" +
      s.peers
        .map(function (p) {
          return p.id + (p.host ? "H" : "") + (p.canUpload ? "U" : "") + (p.ready ? "R" : "");
        })
        .join(",");
    if (peerSig !== lastPeerSig) {
      lastPeerSig = peerSig;
      els.peerList.innerHTML = "";
      els.peerList.appendChild(selfRow(s, isHost));
      s.peers.forEach(function (p) {
        els.peerList.appendChild(peerRow(p, isHost));
      });
      setHidden(els.peerEmpty, s.peers.length > 0);
    }
    s.peers.forEach(function (p) {
      var node = els.peerList.querySelector('[data-drift="' + p.id + '"]');
      if (node) setText(node, Math.abs(Math.round(p.drift)) + " ms");
    });

    setText(els.statCorrections, String(s.corrections));
  }

  function requestRow(r) {
    var row = document.createElement("div");
    row.className = "device-row req-row";

    var left = document.createElement("div");
    var nameP = document.createElement("p");
    nameP.className = "small";
    nameP.textContent = r.name;
    var idP = document.createElement("p");
    idP.className = "mono tiny muted";
    idP.textContent = r.id.slice(0, 8);
    left.appendChild(nameP);
    left.appendChild(idP);

    var right = document.createElement("div");
    right.className = "device-right";

    var allowBtn = document.createElement("button");
    allowBtn.className = "btn btn-sm btn-pill";
    allowBtn.textContent = "Allow";
    allowBtn.addEventListener("click", function () {
      engine.respond(r.id, true);
    });

    var denyBtn = document.createElement("button");
    denyBtn.className = "btn btn-sm";
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", function () {
      engine.respond(r.id, false);
    });

    right.appendChild(allowBtn);
    right.appendChild(denyBtn);
    row.appendChild(left);
    row.appendChild(right);
    return row;
  }

  function selfRow(s, isHost) {
    var row = document.createElement("div");
    row.className = "device-row self";
    var left = document.createElement("div");
    left.className = "device-left";
    var dot = document.createElement("span");
    dot.className = "device-dot ok";
    var label = document.createElement("span");
    label.className = "small";
    label.innerHTML = name + ' <span class="muted">(you' + (isHost ? " · host" : "") + ")</span>";
    left.appendChild(dot);
    left.appendChild(label);
    var right = document.createElement("span");
    right.className = "mono tiny muted";
    right.textContent = s.selfId.slice(0, 8);
    row.appendChild(left);
    row.appendChild(right);
    return row;
  }

  function peerRow(p, isHost) {
    var row = document.createElement("div");
    row.className = "device-row";

    var left = document.createElement("div");
    left.className = "device-left";
    var dot = document.createElement("span");
    dot.className = "device-dot " + (p.ready ? "ok" : "wait");
    var info = document.createElement("div");
    var nameP = document.createElement("p");
    nameP.className = "small";
    nameP.innerHTML =
      p.name +
      (p.host ? ' <span class="muted">· host</span>' : "") +
      (p.canUpload && !p.host ? ' <span class="primary">· can play</span>' : "");
    var idP = document.createElement("p");
    idP.className = "mono tiny muted";
    idP.textContent = p.id.slice(0, 8);
    info.appendChild(nameP);
    info.appendChild(idP);
    left.appendChild(dot);
    left.appendChild(info);

    var right = document.createElement("div");
    right.className = "device-right";
    var driftSpan = document.createElement("span");
    driftSpan.className = "mono tiny muted";
    driftSpan.setAttribute("data-drift", p.id);
    driftSpan.textContent = Math.abs(Math.round(p.drift)) + " ms";
    right.appendChild(driftSpan);

    if (isHost && p.canUpload) {
      var revokeBtn = document.createElement("button");
      revokeBtn.className = "btn btn-sm";
      revokeBtn.textContent = "Revoke";
      revokeBtn.addEventListener("click", function () {
        engine.revoke(p.id);
      });
      right.appendChild(revokeBtn);
    }

    row.appendChild(left);
    row.appendChild(right);
    return row;
  }

  render();
  engine.start();
  window.addEventListener("beforeunload", function () {
    engine.stop();
  });
})();
