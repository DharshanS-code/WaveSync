/**
 * WaveSync LAN relay server — zero dependencies, pure Node.js.
 *
 * Serves the static WaveSync frontend (index.html, style.css, app.js,
 * sync-engine.js) AND a WebSocket relay at /ws so that devices on the
 * same Wi-Fi / hotspot can sync playback in real time.
 *
 * Run:  node server.js
 * Then open http://<this-device-ip>:8080 on every phone on the same Wi-Fi.
 *
 * Buildable via Termux:  pkg install nodejs-lts && node server.js
 */

var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var PORT = process.env.PORT || 8080;

var MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(req, res) {
  var urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";

  // Prevent path traversal.
  var filePath = path.normalize(path.join(__dirname, urlPath));
  if (filePath.indexOf(__dirname) !== 0) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ---- Minimal RFC 6455 WebSocket server (no deps) ----

var WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(req) {
  var key = req.headers["sec-websocket-key"];
  if (!key) return null;
  return crypto
    .createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
}

function mask(buf, maskBytes) {
  var out = Buffer.allocUnsafe(buf.length);
  for (var i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ maskBytes[i % 4];
  }
  return out;
}

function parseFrame(buf) {
  // Returns { opcode, payload, totalLen } or null if incomplete.
  if (buf.length < 2) return null;
  var b0 = buf[0];
  var b1 = buf[1];
  var fin = (b0 & 0x80) !== 0;
  var opcode = b0 & 0x0f;
  var masked = (b1 & 0x80) !== 0;
  var len = b1 & 0x7f;
  var offset = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    // Read 64-bit length (assume < 2^32).
    len = buf.readUInt32BE(6);
    offset = 10;
  }

  var maskBytes = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskBytes = buf.slice(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + len) return null;

  var payload = buf.slice(offset, offset + len);
  if (masked) payload = mask(payload, maskBytes);

  return { fin: fin, opcode: opcode, payload: payload, totalLen: offset + len };
}

function encodeFrame(payload, opcode) {
  if (opcode === undefined) opcode = 0x01; // text
  var len = payload.length;
  var header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, Buffer.from(payload)]);
}

var clients = new Set();

function broadcast(data, except) {
  var frame = encodeFrame(data);
  clients.forEach(function (ws) {
    if (ws !== except && ws.readyState === 1) {
      ws.socket.write(frame);
    }
  });
}

function handleUpgrade(req, socket) {
  var accept = acceptKey(req);
  if (!accept) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  var headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept: " + accept,
    "",
    "",
  ];
  socket.write(headers.join("\r\n"));

  var ws = {
    socket: socket,
    readyState: 1, // OPEN
    buffer: Buffer.alloc(0),
  };

  clients.add(ws);

  socket.on("data", function (chunk) {
    ws.buffer = Buffer.concat([ws.buffer, chunk]);
    var frame;
    while ((frame = parseFrame(ws.buffer))) {
      ws.buffer = ws.buffer.slice(frame.totalLen);

      if (frame.opcode === 0x08) {
        // Close
        ws.readyState = 3;
        clients.delete(ws);
        socket.end();
        return;
      }
      if (frame.opcode === 0x09) {
        // Ping -> Pong
        socket.write(encodeFrame(frame.payload, 0x0a));
        continue;
      }
      if (frame.opcode === 0x01 || frame.opcode === 0x02) {
        // Text or binary — relay to everyone else.
        broadcast(frame.payload, ws);
      }
    }
  });

  socket.on("close", function () {
    clients.delete(ws);
  });
  socket.on("error", function () {
    clients.delete(ws);
  });
}

// ---- HTTP server ----

var server = http.createServer(function (req, res) {
  var urlPath = req.url.split("?")[0];
  if (urlPath === "/ws" && req.headers.upgrade === "websocket") {
    // WebSocket upgrade — handled below in 'upgrade' event.
    res.writeHead(426);
    res.end("Upgrade Required");
    return;
  }
  serveStatic(req, res);
});

server.on("upgrade", function (req, socket, head) {
  var urlPath = req.url.split("?")[0];
  if (urlPath === "/ws") {
    handleUpgrade(req, socket);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, "0.0.0.0", function () {
  var nets = require("os").networkInterfaces();
  var ips = [];
  Object.keys(nets).forEach(function (name) {
    nets[name].forEach(function (net) {
      if (net.family === "IPv4" && !net.internal) {
        ips.push(net.address);
      }
    });
  });
  console.log("");
  console.log("  WaveSync relay running");
  console.log("  ─────────────────────────────────────");
  ips.forEach(function (ip) {
    console.log("  ▸ http://" + ip + ":" + PORT);
  });
  console.log("");
  console.log("  Open one of those URLs on every device on the same Wi-Fi.");
  console.log("  They join automatically — no codes needed.");
  console.log("");
});
