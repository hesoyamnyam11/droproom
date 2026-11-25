// Pengelola koneksi langsung WebRTC P2P versi statis (via PeerJS signaling)
const CHUNK_SIZE = 32 * 1024;
const MAX_BUFFERED_AMOUNT = 256 * 1024;
const LOW_BUFFERED_THRESHOLD = 64 * 1024;
const CONNECT_WATCHDOG_MS = 7000;
const PEER_PREFIX = "droproom-p2p-v1-";

const DEFAULT_ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export class DirectPeerSession {
  constructor({ code, role, getRemainingSeconds, callbacks }) {
    this.code = code;
    this.role = role; // "host" | "guest"
    this.getRemainingSeconds = getRemainingSeconds;
    this.cb = callbacks;

    this.peer = null;
    this.conn = null;
    this.incomingFiles = new Map();
    this.currentIncomingFileId = null;
    this.recvQueue = Promise.resolve();
    this.connectTimer = null;
    this.isClosing = false;
  }

  connect() {
    if (typeof window.Peer !== "function") {
      this.cb.onError("peer_sdk_missing");
      return;
    }

    this.isClosing = false;
    this._destroyPeerOnly();

    const peerId = this.role === "host" ? `${PEER_PREFIX}${this.code}` : undefined;
    this.peer = new window.Peer(peerId, {
      config: { iceServers: DEFAULT_ICE_SERVERS },
    });

    this.peer.on("open", () => {
      if (this.isClosing) return;
      if (this.role === "host") {
        this.cb.onJoined({
          role: "host",
          peerCount: 1,
          remainingSeconds: this.getRemainingSeconds(),
        });
        this.cb.onStatusChange("waiting", "Menunggu perangkat kedua");
      } else {
        this.cb.onStatusChange("waiting", "Menghubungkan jalur langsung...");
        this._connectToHost();
      }
    });

    this.peer.on("connection", (incomingConn) => {
      if (this.role !== "host") return;

      // Batasi ketat maksimal 2 perangkat per ruangan
      if (this.conn && this.conn.open) {
        incomingConn.on("open", () => {
          try {
            incomingConn.send(JSON.stringify({ type: "room_full" }));
          } catch {}
          setTimeout(() => {
            try { incomingConn.close(); } catch {}
          }, 250);
        });
        return;
      }

      this.cb.onStatusChange("waiting", "Perangkat ditemukan, menghubungkan...");
      this._attachConnection(incomingConn);
    });

    this.peer.on("disconnected", () => {
      if (!this.isClosing && this.peer && !this.peer.destroyed) {
        try {
          this.peer.reconnect();
        } catch {}
      }
    });

    this.peer.on("error", (err) => {
      if (this.isClosing) return;
      const errType = err?.type || "";
      if (errType === "peer-unavailable") {
        this._clearWatchdog();
        this.cb.onError("room_not_found");
        this.cleanup();
      } else if (errType === "unavailable-id") {
        this._clearWatchdog();
        this.cb.onError("code_taken");
        this.cleanup();
      } else {
        this.cb.onIceTrouble();
      }
    });
  }

  _connectToHost() {
    if (!this.peer || this.peer.destroyed) return;
    this._closeConnectionOnly();
    this._armWatchdog();

    const conn = this.peer.connect(`${PEER_PREFIX}${this.code}`, {
      reliable: true,
      serialization: "raw",
    });
    this._attachConnection(conn);
  }

  _attachConnection(conn) {
    this._closeConnectionOnly();
    this.conn = conn;

    const configureChannel = () => {
      if (this.conn?.dataChannel) {
        this.conn.dataChannel.binaryType = "arraybuffer";
        this.conn.dataChannel.bufferedAmountLowThreshold = LOW_BUFFERED_THRESHOLD;
      }
    };

    configureChannel();

    conn.on("open", () => {
      if (this.isClosing || this.conn !== conn) return;
      configureChannel();
      this._clearWatchdog();

      if (this.role === "host") {
        try {
          conn.send(
            JSON.stringify({
              type: "room_meta",
              remainingSeconds: this.getRemainingSeconds(),
            })
          );
        } catch {}
      }

      this.cb.onStatusChange("connected", "Terhubung langsung (P2P)");
      this.cb.onChannelReady(true);
    });

    conn.on("data", (data) => {
      if (this.isClosing || this.conn !== conn) return;
      this.recvQueue = this.recvQueue.then(() => this._handleDataMessage(data));
    });

    conn.on("close", () => {
      if (this.isClosing || this.conn !== conn) return;
      this._clearWatchdog();
      this.conn = null;
      this.incomingFiles.clear();
      this.currentIncomingFileId = null;

      if (this.role === "host") {
        this.cb.onStatusChange("waiting", "Perangkat lain keluar, menunggu lagi...");
        this.cb.onPeerDisconnected();
      } else {
        this.cb.onStatusChange("disconnected", "Terputus dari pembuat ruangan");
        this.cb.onPeerDisconnected();
        this.cb.onIceTrouble();
      }
    });

    conn.on("error", () => {
      if (!this.isClosing) {
        this.cb.onIceTrouble();
      }
    });
  }

  _clearWatchdog() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  _armWatchdog() {
    this._clearWatchdog();
    this.connectTimer = setTimeout(() => {
      if (this.isClosing || this.isReady()) return;
      this.cb.onIceTrouble();
    }, CONNECT_WATCHDOG_MS);
  }

  async retryConnection() {
    if (this.isClosing) return;
    this.cb.onStatusChange("waiting", "Menyambung ulang...");

    if (!this.peer || this.peer.destroyed) {
      this.connect();
      return;
    }
    if (this.peer.disconnected) {
      try {
        this.peer.reconnect();
      } catch {}
    }
    if (this.role === "guest") {
      this._connectToHost();
    }
  }

  async _handleDataMessage(data) {
    if (typeof data === "string") {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      if (msg.type === "room_full") {
        this.cb.onError("room_full");
        this.cleanup();
      } else if (msg.type === "room_meta") {
        this.cb.onJoined({
          role: "guest",
          peerCount: 2,
          remainingSeconds: msg.remainingSeconds,
        });
      } else if (msg.type === "room_closed") {
        this.cb.onRoomDestroyed("Ruangan ditutup dan seluruh data telah dihapus.");
        this.cleanup();
      } else if (msg.type === "room_expired") {
        this.cb.onRoomDestroyed("Waktu ruangan 10 menit telah habis.");
        this.cleanup();
      } else if (msg.type === "text") {
        this.cb.onTextReceived(msg);
      } else if (msg.type === "file_meta") {
        this.incomingFiles.set(msg.id, {
          meta: msg,
          chunks: [],
          receivedBytes: 0,
          startedAt: performance.now(),
        });
        this.currentIncomingFileId = msg.id;
        this.cb.onFileIncomingStart(msg);
      } else if (msg.type === "file_end") {
        const entry = this.incomingFiles.get(msg.id);
        if (!entry) return;
        const blob = new Blob(entry.chunks, {
          type: entry.meta.mime || "application/octet-stream",
        });
        this.incomingFiles.delete(msg.id);
        this.cb.onFileIncomingComplete(entry.meta, blob);
      } else if (msg.type === "file_burned") {
        this.cb.onPeerBurnedFile(msg.id);
      }
      return;
    }

    // Potongan biner file
    let buffer = null;
    if (data instanceof ArrayBuffer) {
      buffer = data;
    } else if (data instanceof Blob) {
      buffer = await data.arrayBuffer();
    } else if (ArrayBuffer.isView(data)) {
      buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    if (!buffer) return;

    const activeId = this.currentIncomingFileId;
    if (!activeId || !this.incomingFiles.has(activeId)) return;
    const entry = this.incomingFiles.get(activeId);
    entry.chunks.push(buffer);
    entry.receivedBytes += buffer.byteLength;

    const elapsedSec = Math.max(0.05, (performance.now() - entry.startedAt) / 1000);
    const speedBps = entry.receivedBytes / elapsedSec;
    this.cb.onFileProgress(activeId, entry.receivedBytes, entry.meta.size, speedBps);
  }

  isReady() {
    return Boolean(this.conn && this.conn.open);
  }

  sendText(content) {
    if (!this.isReady()) return null;
    const payload = {
      type: "text",
      id: `txt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      content,
      timestamp: Date.now(),
    };
    this.conn.send(JSON.stringify(payload));
    return payload;
  }

  notifyFileBurned(fileId) {
    if (!this.isReady()) return;
    this.conn.send(JSON.stringify({ type: "file_burned", id: fileId }));
  }

  notifyRoomExpired() {
    if (this.isReady()) {
      try {
        this.conn.send(JSON.stringify({ type: "room_expired" }));
      } catch {}
    }
    setTimeout(() => this.cleanup(), 150);
  }

  async sendFile(fileOrBlob, burnAfterDownload, onProgress, metaOverride = {}) {
    if (!this.isReady()) {
      throw new Error("Jalur langsung belum terhubung.");
    }

    const fileId = `file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const meta = {
      type: "file_meta",
      id: fileId,
      name: metaOverride.name || fileOrBlob.name || "file",
      size: fileOrBlob.size,
      mime: metaOverride.mime || fileOrBlob.type || "application/octet-stream",
      burnAfterDownload: Boolean(burnAfterDownload),
    };

    this.conn.send(JSON.stringify(meta));

    let offset = 0;
    const startedAt = performance.now();

    while (offset < fileOrBlob.size) {
      if (!this.isReady()) {
        throw new Error("Koneksi terputus saat mengirim file.");
      }

      const dc = this.conn.dataChannel;
      if (dc && dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            dc.removeEventListener("bufferedamountlow", finish);
            resolve();
          };
          dc.addEventListener("bufferedamountlow", finish);
          setTimeout(finish, 180);
        });
      }

      const slice = fileOrBlob.slice(offset, offset + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();
      this.conn.send(buffer);
      offset += buffer.byteLength;

      const elapsedSec = Math.max(0.05, (performance.now() - startedAt) / 1000);
      const speedBps = offset / elapsedSec;
      if (onProgress) {
        onProgress(fileId, offset, fileOrBlob.size, speedBps);
      }
    }

    this.conn.send(JSON.stringify({ type: "file_end", id: fileId }));
    return meta;
  }

  requestDestroyRoom() {
    this.isClosing = true;
    this._clearWatchdog();
    if (this.conn && this.conn.open) {
      try {
        this.conn.send(JSON.stringify({ type: "room_closed" }));
      } catch {}
    }
    setTimeout(() => this.cleanup(), 150);
  }

  _closeConnectionOnly() {
    if (this.conn) {
      try { this.conn.close(); } catch {}
      this.conn = null;
    }
    this.incomingFiles.clear();
    this.currentIncomingFileId = null;
  }

  _destroyPeerOnly() {
    this._closeConnectionOnly();
    if (this.peer) {
      try { this.peer.destroy(); } catch {}
      this.peer = null;
    }
  }

  cleanup() {
    this.isClosing = true;
    this._clearWatchdog();
    this._destroyPeerOnly();
  }
}