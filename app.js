/**
 * WaveSync app — UI controller, vanilla JS, zero dependencies.
 * Pairs with sync-engine.js and style.css.
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

  var els = {
    deviceName: document.getElementById("deviceName"),
    deviceId: document.getElementById("deviceId"),
    statusDot: document.getElementById("statusDot"),
    statusTitle: document.getElementById("statusTitle"),
    statusSub: document.getElementById("statusSub"),
    driftBox: document.getElementById("driftBox"),
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
    controls: document.getElementById("controls"),
    reqSection: document.getElementById("reqSection"),
    reqList: document.getElementById("reqList"),
    peerList: document.getElementById("peerList"),
    statCorrections: document.getElementById("statCorrections"),
  };

  els.deviceName.textContent = name;

  var engine = new SyncEngine({
    name: name,
    audio: function () {
      return audio;
    },
    onState: render,
  });

  engine.start();
  window.addEventListener("beforeunload", function () {
    engine.stop();
  });

  function fmt(s) {
    if (!isFinite(s)) return "0:00";
    var m = Math.floor(s / 60);
    var r = Math.floor(s % 60);
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  function pick(file) {
    if (!file) return;
    var url = URL.createObjectURL(file);
    track = { name: file.name.replace(/\.[^.]+$/, ""), url: url };
    pos = 0;
    playing = false;
    engine.promote();
    render(engineState);
  }

  function toggle() {
    if (!audio || !track) return;
    if (audio.paused) {
      audio.play().catch(function () {});
    } else {
      audio.pause();
    }
  }

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
    render(engineState);
  });
  audio.addEventListener("pause", function () {
    playing = false;
    render(engineState);
  });

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

  function render(s) {
    engineState = s;

    els.deviceId.textContent = "id " + (s.selfId.slice(0, 8) || "…");

    var isHost = s.role === "host";
    var isGuest = s.role === "guest";
    var drift = Math.abs(Math.round(s.drift));
    var listeners = s.peers.length + 1;
    var canControl = isHost || s.canUpload;

    // Status bar
    if (s.role === "idle") {
      els.statusDot.className = "dot";
      els.statusTitle.textContent = "Scanning the network…";
      els.statusSub.textContent = "Devices on the same Wi-Fi join automatically";
      els.driftBox.hidden = true;
    } else {
      els.statusDot.className = "dot live";
      els.statusTitle.textContent = "Connected · " + s.network;
      els.statusSub.textContent =
        listeners + " device" + (listeners === 1 ? "" : "s") +
        " · you are " + (isHost ? "the host" : "a guest");
      els.driftBox.hidden = false;
      var driftCls = drift <= 10 ? "primary" : drift <= 60 ? "accent" : "destructive";
      els.driftValue.className = "mono big bold " + driftCls;
      els.driftValue.textContent = "±" + (isGuest ? drift : 0) + " ms";
      els.clockOffset.textContent =
        "clock " + (s.offset >= 0 ? "+" : "") + Math.round(s.offset) + " ms";
    }

    // Bars animation
    els.bars.className = "bars" + (playing ? " playing" : "");
    els.artBg.className = "art-bg" + (playing ? " playing" : "");

    // Art + track
    var displayTrack = track ? track.name : s.hostTrack;
    els.artLetter.textContent = (displayTrack || "W").charAt(0).toUpperCase();
    els.trackName.textContent = displayTrack || "No track selected";
    els.trackSub.textContent = isGuest
      ? "Following the host"
      : "Local file · MP3, AAC, OGG, FLAC, WAV";
    els.progressBar.style.width = (dur ? (pos / dur) * 100 : 0) + "%";
    els.curTime.textContent = fmt(pos);
    els.durTime.textContent = fmt(dur);

    // Host track sync
    if (isHost) engine.setTrack(track ? track.name : null);

    // Controls
    els.controls.innerHTML = "";
    if (canControl) {
      var label = document.createElement("label");
      label.className = "btn";
      label.textContent = "Choose file";
      var input = document.createElement("input");
      input.type = "file";
      input.accept = "audio/*";
      input.style.display = "none";
      input.addEventListener("change", function (e) {
        pick(e.target.files && e.target.files[0]);
      });
      label.appendChild(input);
      els.controls.appendChild(label);
    } else {
      var reqBtn = document.createElement("button");
      reqBtn.className = "btn";
      reqBtn.textContent = asked ? "Waiting for host…" : "Request permission to play";
      reqBtn.disabled = asked || s.role === "idle";
      reqBtn.addEventListener("click", function () {
        engine.requestUpload();
        asked = true;
        render(s);
      });
      els.controls.appendChild(reqBtn);
    }

    var playBtn = document.createElement("button");
    playBtn.className = "btn btn-pill";
    playBtn.textContent = playing ? "Pause" : "Play";
    playBtn.disabled = !track || !canControl;
    playBtn.addEventListener("click", toggle);
    els.controls.appendChild(playBtn);

    // Reset ask state when permission granted
    if (s.canUpload) asked = false;

    // Permission requests (host only)
    if (isHost && s.requests.length > 0) {
      els.reqSection.hidden = false;
      els.reqList.innerHTML = "";
      s.requests.forEach(function (r) {
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
        els.reqList.appendChild(row);
      });
    } else {
      els.reqSection.hidden = true;
    }

    // Peer list
    els.peerList.innerHTML = "";

    // Self
    var selfRow = document.createElement("div");
    selfRow.className = "device-row self";
    var selfLeft = document.createElement("div");
    selfLeft.className = "device-left";
    var selfDot = document.createElement("span");
    selfDot.className = "device-dot ok";
    var selfName = document.createElement("span");
    selfName.className = "small";
    selfName.innerHTML = name + ' <span class="muted">(you' + (isHost ? " · host" : "") + ")</span>";
    selfLeft.appendChild(selfDot);
    selfLeft.appendChild(selfName);
    var selfRight = document.createElement("span");
    selfRight.className = "mono tiny muted";
    selfRight.textContent = s.selfId.slice(0, 8);
    selfRow.appendChild(selfLeft);
    selfRow.appendChild(selfRight);
    els.peerList.appendChild(selfRow);

    s.peers.forEach(function (p) {
      var row = document.createElement("div");
      row.className = "device-rise device-row";

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
      els.peerList.appendChild(row);
    });

    if (s.peers.length === 0) {
      var empty = document.createElement("p");
      empty.className = "tiny muted";
      empty.textContent =
        "No other devices yet. Open this page on another device connected to the same Wi-Fi — it joins by itself.";
      els.peerList.appendChild(empty);
    }

    // Stats
    els.statCorrections.textContent = String(s.corrections);
  }

  // Initial render
  render(engineState);
})();
