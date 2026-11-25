// Pengelola koneksi langsung WebRTC DataChannel (2 perangkat) + Auto-Retry
const CHUNK_SIZE = 32 * 1024;
const MAX_BUFFERED_AMOUNT = 256 * 1024;
const LOW_BUFFERED_THRESHOLD = 64 * 1024;
const CONNECT_WATCHDOG_MS = 5500;

export class DirectPeerSession {
  constructor({ code, iceServers, callbacks }) {
    this.code = code;
    this.iceServers = iceServers;
    this.cb = callbacks;

    this.ws = null;
    this.pc = null;
    this.dc = null;
    this.role = null;
    this.pendingCandidates = [];
    this.incomingFiles = new Map();
    this.currentIncomingFileId = null;
    this.connectTimer = null;
    this.autoRetryCount = 0;
    this.isClosing = false;
  }

  connect() {
    this.isClosing = false;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${window.location.host}/ws/${encodeURIComponent(this.code)}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.addEventListener("message", async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      await this._handleSignal(msg);
    });

    this.ws.addEventListener("close", () => {
      this._clearWatchdog();
      if (!this.isClosing) {
        this.cb.onStatusChange("disconnected", "Koneksi signaling terputus");
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
      if (this.role === "host" && this.autoRetryCount < 1 && this.ws?.readyState === WebSocket.OPEN) {
        this.autoRetryCount += 1;
        this.cb.onStatusChange("waiting", "Mencoba jalur langsung ulang...");
        this._startOffer();
      } else {
        this.cb.onIceTrouble();
      }
    }, CONNECT_WATCHDOG_MS);
  }

  async retryConnection() {
    if (this.isClosing) return;
    this.autoRetryCount = 0;
    this.cb.onStatusChange("waiting", "Menyambung ulang...");

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connect();
      return;
    }
    await this._startOffer();
  }

  async _handleSignal(msg) {
    switch (msg.type) {
      case "error":
        this.cb.onError(msg.code);
        this.cleanup();
        break;

      case "joined":
        this.role = msg.role;
        this.autoRetryCount = 0;
        this.cb.onJoined({
          role: msg.role,
          peerCount: msg.peer_count,
          remainingSeconds: msg.remaining_seconds,
        });
        if (msg.peer_count === 1) {
          this.cb.onStatusChange("waiting", "Menunggu perangkat kedua");
        } else {
          this.cb.onStatusChange("waiting", "Menghubungkan jalur langsung...");
          this._armWatchdog();
        }
        break;

      case "peer_joined":
        this.autoRetryCount = 0;
        this.cb.onStatusChange("waiting", "Perangkat ditemukan, menghubungkan...");
        await this._startOffer();
        break;

      case "offer":
        await this._handleOffer(msg.sdp);
        break;

      case "answer":
        await this._handleAnswer(msg.sdp);
        break;

      case "ice":
        await this._handleRemoteIce(msg.candidate);
        break;

      case "peer_left":
        this._clearWatchdog();
        this._closePeerConnectionOnly();
        this.cb.onStatusChange("waiting", "Perangkat lain keluar, menunggu lagi...");
        this.cb.onPeerDisconnected();
        break;

      case "room_closed":
        this.cb.onRoomDestroyed("Ruangan ditutup dan seluruh data telah dihapus.");
        this.cleanup();
        break;

      case "room_expired":
        this.cb.onRoomDestroyed("Waktu ruangan 10 menit telah habis.");
        this.cleanup();
        break;
    }
  }

  _sendSignal(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  _createPeerConnection() {
    this._closePeerConnectionOnly();
    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._sendSignal({ type: "ice", candidate: event.candidate });
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (!this.pc) return;
      const state = this.pc.iceConnectionState;
      if (state === "failed" || state === "disconnected") {
        this.cb.onIceTrouble();
      }
    };

    this.pc.ondatachannel = (event) => {
      this._setupDataChannel(event.channel);
    };
  }

  _setupDataChannel(channel) {
    this.dc = channel;
    this.dc.binaryType = "arraybuffer";
    this.dc.bufferedAmountLowThreshold = LOW_BUFFERED_THRESHOLD;

    this.dc.onopen = () => {
      this._clearWatchdog();
      this.autoRetryCount = 0;
      this.cb.onStatusChange("connected", "Terhubung langsung (P2P)");
      this.cb.onChannelReady(true);
    };

    this.dc.onclose = () => {
      this.cb.onChannelReady(false);
    };

    this.dc.onmessage = (event) => {
      this._handleDataMessage(event.data);
    };
  }

  async _startOffer() {
    this._createPeerConnection();
    const channel = this.pc.createDataChannel("droproom", { ordered: true });
    this._setupDataChannel(channel);

    const offer = await this.pc.createOffer({ iceRestart: true });
    await this.pc.setLocalDescription(offer);
    this._sendSignal({ type: "offer", sdp: offer });
    this._armWatchdog();
  }

  async _handleOffer(sdp) {
    this._createPeerConnection();
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await this._flushPendingCandidates();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this._sendSignal({ type: "answer", sdp: answer });
    this._armWatchdog();
  }

  async _handleAnswer(sdp) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await this._flushPendingCandidates();
  }

  async _handleRemoteIce(candidate) {
    if (!candidate) return;
    if (this.pc && this.pc.remoteDescription) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Abaikan kandidat terlambat
      }
    } else {
      this.pendingCandidates.push(candidate);
    }
  }

  async _flushPendingCandidates() {
    while (this.pendingCandidates.length > 0 && this.pc && this.pc.remoteDescription) {
      const candidate = this.pendingCandidates.shift();
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Abaikan
      }
    }
  }

  _handleDataMessage(data) {
    if (typeof data === "string") {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      if (msg.type === "text") {
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

    const activeId = this.currentIncomingFileId;
    if (!activeId || !this.incomingFiles.has(activeId)) return;
    const entry = this.incomingFiles.get(activeId);
    entry.chunks.push(data);
    entry.receivedBytes += data.byteLength;

    const elapsedSec = Math.max(0.05, (performance.now() - entry.startedAt) / 1000);
    const speedBps = entry.receivedBytes / elapsedSec;
    this.cb.onFileProgress(activeId, entry.receivedBytes, entry.meta.size, speedBps);
  }

  isReady() {
    return Boolean(this.dc && this.dc.readyState === "open");
  }

  sendText(content) {
    if (!this.isReady()) return null;
    const payload = {
      type: "text",
      id: `txt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      content,
      timestamp: Date.now(),
    };
    this.dc.send(JSON.stringify(payload));
    return payload;
  }

  notifyFileBurned(fileId) {
    if (!this.isReady()) return;
    this.dc.send(JSON.stringify({ type: "file_burned", id: fileId }));
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

    this.dc.send(JSON.stringify(meta));

    let offset = 0;
    const startedAt = performance.now();

    while (offset < fileOrBlob.size) {
      if (!this.isReady()) {
        throw new Error("Koneksi terputus saat mengirim file.");
      }

      if (this.dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        await new Promise((resolve) => {
          const handler = () => {
            this.dc.removeEventListener("bufferedamountlow", handler);
            resolve();
          };
          this.dc.addEventListener("bufferedamountlow", handler);
        });
      }

      const slice = fileOrBlob.slice(offset, offset + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();
      this.dc.send(buffer);
      offset += buffer.byteLength;

      const elapsedSec = Math.max(0.05, (performance.now() - startedAt) / 1000);
      const speedBps = offset / elapsedSec;
      if (onProgress) {
        onProgress(fileId, offset, fileOrBlob.size, speedBps);
      }
    }

    this.dc.send(JSON.stringify({ type: "file_end", id: fileId }));
    return meta;
  }

  requestDestroyRoom() {
    this.isClosing = true;
    this._clearWatchdog();
    this._sendSignal({ type: "close_room" });
    this.cleanup();
  }

  _closePeerConnectionOnly() {
    if (this.dc) {
      try { this.dc.close(); } catch {}
      this.dc = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
    this.pendingCandidates = [];
    this.incomingFiles.clear();
    this.currentIncomingFileId = null;
  }

  cleanup() {
    this.isClosing = true;
    this._clearWatchdog();
    this._closePeerConnectionOnly();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}