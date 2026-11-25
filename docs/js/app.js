import { initTheme } from "./theme.js";
import { DirectPeerSession } from "./webrtc.js";

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_TTL_SECONDS = 600;

const lobbyView = document.getElementById("lobbyView");
const roomView = document.getElementById("roomView");
const createRoomBtn = document.getElementById("createRoomBtn");
const joinRoomForm = document.getElementById("joinRoomForm");
const joinCodeInput = document.getElementById("joinCodeInput");
const lobbyError = document.getElementById("lobbyError");

const connectionPill = document.getElementById("connectionPill");
const connectionText = document.getElementById("connectionText");
const roomCodeDisplay = document.getElementById("roomCodeDisplay");
const timerBadge = document.getElementById("timerBadge");
const copyCodeBtn = document.getElementById("copyCodeBtn");
const qrToggleBtn = document.getElementById("qrToggleBtn");
const qrSection = document.getElementById("qrSection");
const qrContainer = document.getElementById("qrContainer");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const localhostHint = document.getElementById("localhostHint");
const connectionHelpBox = document.getElementById("connectionHelpBox");
const reconnectBtn = document.getElementById("reconnectBtn");
const destroyRoomBtn = document.getElementById("destroyRoomBtn");

const syncHistoryBanner = document.getElementById("syncHistoryBanner");
const syncHistoryText = document.getElementById("syncHistoryText");
const syncHistoryBtn = document.getElementById("syncHistoryBtn");
const dismissSyncBtn = document.getElementById("dismissSyncBtn");

const streamArea = document.getElementById("streamArea");
const transferFeed = document.getElementById("transferFeed");
const emptyFeedState = document.getElementById("emptyFeedState");
const emptyStreamTitle = document.getElementById("emptyStreamTitle");
const emptyStreamSub = document.getElementById("emptyStreamSub");

const pendingQueueBar = document.getElementById("pendingQueueBar");
const pendingQueueTitle = document.getElementById("pendingQueueTitle");
const clearQueueBtn = document.getElementById("clearQueueBtn");
const pendingQueueList = document.getElementById("pendingQueueList");

const fileInput = document.getElementById("fileInput");
const attachFileBtn = document.getElementById("attachFileBtn");
const burnToggle = document.getElementById("burnToggle");
const burnToggleLabel = document.getElementById("burnToggleLabel");
const textForm = document.getElementById("textForm");
const textInput = document.getElementById("textInput");
const sendTextBtn = document.getElementById("sendTextBtn");
const globalDropOverlay = document.getElementById("globalDropOverlay");
const toastContainer = document.getElementById("toastContainer");

const previewModal = document.getElementById("previewModal");
const previewModalTitle = document.getElementById("previewModalTitle");
const closePreviewBtn = document.getElementById("closePreviewBtn");
const previewModalBody = document.getElementById("previewModalBody");

let activeSession = null;
let activeRoomCode = null;
let activeRoomRole = null;
let activeJoinUrl = "";
let hasQrSvg = false;
let timerInterval = null;
let remainingSeconds = ROOM_TTL_SECONDS;
let feedItemCount = 0;
let dragDepth = 0;
const blobUrls = new Map();
let sessionHistory = [];
let pendingFiles = [];
let sendQueue = Promise.resolve();

function generateRoomCode() {
  const bytes = new Uint8Array(6);
  window.crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  }
  return code;
}

function buildJoinUrl(code) {
  return `${window.location.origin}${window.location.pathname}?room=${code}`;
}

function generateQrSvgClient(url) {
  if (typeof window.qrcode !== "function") return "";
  const qr = window.qrcode(0, "M");
  qr.addData(url);
  qr.make();
  return qr.createSvgTag(6, 2);
}

function showToast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3200);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function linkifyEscapedText(rawText) {
  const safe = escapeHtml(rawText);
  return safe.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, idx);
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

function formatTimeNow() {
  return new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

function getPreviewKind(mime = "", name = "") {
  const m = mime.toLowerCase();
  const n = name.toLowerCase();
  if (m.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|svg)$/.test(n)) return "image";
  if (m.startsWith("video/") || /\.(mp4|webm|ogg|mov)$/.test(n)) return "video";
  if (m.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac)$/.test(n)) return "audio";
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  return null;
}

function scrollStreamToBottom() {
  requestAnimationFrame(() => {
    streamArea.scrollTop = streamArea.scrollHeight;
  });
}

function setQrVisible(visible) {
  if (!hasQrSvg) {
    qrSection.classList.add("hidden");
    qrToggleBtn.classList.add("hidden");
    return;
  }
  qrToggleBtn.classList.remove("hidden");
  qrSection.classList.toggle("hidden", !visible);
  qrToggleBtn.textContent = visible ? "Sembunyikan QR" : "Tampilkan QR";
}

async function copyTextSafe(text, successMsg) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    showToast(successMsg);
  } catch {
    showToast("Gagal menyalin otomatis. Salin secara manual.");
  }
}

/* Antrean Persetujuan Sebelum Kirim */
function addFilesToPendingQueue(fileList) {
  if (!activeSession || !activeSession.isReady()) {
    showToast("Tunggu perangkat kedua terhubung terlebih dahulu.");
    return;
  }
  for (const file of Array.from(fileList)) {
    const isImage = getPreviewKind(file.type, file.name) === "image";
    const previewUrl = isImage ? URL.createObjectURL(file) : null;
    pendingFiles.push({
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      file,
      previewUrl,
      isImage,
    });
  }
  renderPendingQueue();
}

function removePendingFile(id) {
  const idx = pendingFiles.findIndex((item) => item.id === id);
  if (idx === -1) return;
  const [removed] = pendingFiles.splice(idx, 1);
  if (removed.previewUrl) {
    URL.revokeObjectURL(removed.previewUrl);
  }
  renderPendingQueue();
}

function clearPendingQueue() {
  for (const item of pendingFiles) {
    if (item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }
  pendingFiles = [];
  renderPendingQueue();
}

function renderPendingQueue() {
  if (pendingFiles.length === 0) {
    pendingQueueBar.classList.add("hidden");
    pendingQueueList.innerHTML = "";
    sendTextBtn.textContent = "Kirim";
    return;
  }

  pendingQueueBar.classList.remove("hidden");
  const burnNote = burnToggle.checked ? " (mode sekali unduh aktif)" : "";
  pendingQueueTitle.textContent = `${pendingFiles.length} file siap dikirim${burnNote}`;
  sendTextBtn.textContent = `Kirim (${pendingFiles.length})`;

  pendingQueueList.innerHTML = "";
  for (const item of pendingFiles) {
    const chip = document.createElement("div");
    chip.className = "pending-chip";

    const thumbHtml = item.isImage && item.previewUrl
      ? `<img class="pending-thumb" src="${item.previewUrl}" alt="" />`
      : `<span class="pending-file-icon" aria-hidden="true">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
             <polyline points="14 2 14 8 20 8"/>
           </svg>
         </span>`;

    chip.innerHTML = `
      ${thumbHtml}
      <div class="pending-info">
        <span class="pending-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</span>
        <span class="pending-size">${formatBytes(item.file.size)}</span>
      </div>
      <button type="button" class="pending-remove-btn" aria-label="Batalkan ${escapeHtml(item.file.name)}">&times;</button>
    `;

    chip.querySelector(".pending-remove-btn").addEventListener("click", () => {
      removePendingFile(item.id);
    });

    pendingQueueList.appendChild(chip);
  }
}

/* Modal Pratinjau Media */
function openPreviewModal({ url, name, kind }) {
  previewModalTitle.textContent = name;
  previewModalBody.innerHTML = "";

  if (kind === "image") {
    const img = document.createElement("img");
    img.src = url;
    img.alt = name;
    img.className = "preview-media-img";
    previewModalBody.appendChild(img);
  } else if (kind === "video") {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.className = "preview-media-video";
    previewModalBody.appendChild(video);
  } else if (kind === "audio") {
    const audio = document.createElement("audio");
    audio.src = url;
    audio.controls = true;
    audio.autoplay = true;
    audio.className = "preview-media-audio";
    previewModalBody.appendChild(audio);
  } else if (kind === "pdf") {
    const iframe = document.createElement("iframe");
    iframe.src = url;
    iframe.title = name;
    iframe.className = "preview-media-pdf";
    previewModalBody.appendChild(iframe);
  }

  previewModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closePreviewModal() {
  previewModal.classList.add("hidden");
  previewModalBody.innerHTML = "";
  document.body.style.overflow = "";
}

function attachFilePreview(fileId, { url, name, mime, direction, burnAfterDownload }) {
  const kind = getPreviewKind(mime, name);
  if (!kind) return;

  const previewSlot = document.getElementById(`preview-${fileId}`);
  const actionsEl = document.getElementById(`actions-${fileId}`);
  const isBlurredForReceiver = direction === "in" && burnAfterDownload;

  if (kind === "image" && previewSlot) {
    previewSlot.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = `preview-thumb-wrap${isBlurredForReceiver ? "" : " clickable"}`;

    const img = document.createElement("img");
    img.src = url;
    img.alt = name;
    img.className = `preview-thumb${isBlurredForReceiver ? " blurred" : ""}`;
    wrap.appendChild(img);

    if (isBlurredForReceiver) {
      const overlay = document.createElement("div");
      overlay.className = "blur-overlay";
      overlay.textContent = "Diburamkan (sekali unduh)";
      wrap.appendChild(overlay);
    } else {
      wrap.addEventListener("click", () => openPreviewModal({ url, name, kind: "image" }));
    }

    previewSlot.appendChild(wrap);
    scrollStreamToBottom();
    return;
  }

  if (isBlurredForReceiver) {
    if (previewSlot) {
      previewSlot.innerHTML = `<div class="burn-locked-note">Pratinjau dikunci untuk file sekali unduh. Klik Unduh & Hapus untuk membuka.</div>`;
    }
    return;
  }

  if (actionsEl && !actionsEl.querySelector(".preview-open-btn")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-ghost btn-sm preview-open-btn";
    btn.textContent = "Pratinjau";
    btn.addEventListener("click", () => openPreviewModal({ url, name, kind }));
    actionsEl.prepend(btn);
  }
}

function updateEmptyState() {
  emptyFeedState.classList.toggle("hidden", feedItemCount > 0);
}

function setStatusPill(mode, text) {
  connectionPill.classList.remove("hidden", "connected", "disconnected");
  if (mode === "connected") connectionPill.classList.add("connected");
  if (mode === "disconnected") connectionPill.classList.add("disconnected");
  connectionText.textContent = text;
}

function setWorkspaceEnabled(enabled) {
  attachFileBtn.disabled = !enabled;
  burnToggle.disabled = !enabled;
  burnToggleLabel.classList.toggle("disabled", !enabled);
  textInput.disabled = !enabled;
  sendTextBtn.disabled = !enabled;

  if (enabled) {
    emptyStreamTitle.textContent = "Jalur langsung siap dipakai";
    emptyStreamSub.textContent = "Seret file ke mana saja di layar ini, klik ikon klip, atau ketik pesan di bawah.";
    connectionHelpBox.classList.add("hidden");
    setQrVisible(false);
  } else {
    if (hasQrSvg) {
      emptyStreamTitle.textContent = "Menunggu perangkat kedua bergabung";
      emptyStreamSub.textContent = "Pindai QR Code di atas atau ketik kode ruangan di perangkat kedua.";
    } else {
      emptyStreamTitle.textContent = "Menghubungkan ke ruangan...";
      emptyStreamSub.textContent = "Sedang menyambungkan jalur langsung ke perangkat pembuat ruangan.";
    }
    syncHistoryBanner.classList.add("hidden");
    clearPendingQueue();
    setQrVisible(true);
  }
}

function maybeShowSyncBanner() {
  if (sessionHistory.length === 0) {
    syncHistoryBanner.classList.add("hidden");
    return;
  }
  const textCount = sessionHistory.filter((i) => i.type === "text").length;
  const fileCount = sessionHistory.filter((i) => i.type === "file").length;
  const parts = [];
  if (textCount > 0) parts.push(`${textCount} teks`);
  if (fileCount > 0) parts.push(`${fileCount} file`);
  syncHistoryText.textContent = `Kirim ulang riwayat sesi (${parts.join(" & ")}) ke perangkat yang baru masuk?`;
  syncHistoryBtn.disabled = false;
  syncHistoryBtn.textContent = "Kirim riwayat";
  syncHistoryBanner.classList.remove("hidden");
}

async function handleSyncHistory() {
  if (!activeSession || !activeSession.isReady() || sessionHistory.length === 0) {
    syncHistoryBanner.classList.add("hidden");
    return;
  }

  syncHistoryBtn.disabled = true;
  syncHistoryBtn.textContent = "Mengirim...";
  const itemsToSync = [...sessionHistory];

  sendQueue = sendQueue.then(async () => {
    let sentCount = 0;
    for (const item of itemsToSync) {
      if (!activeSession || !activeSession.isReady()) break;
      try {
        if (item.type === "text") {
          activeSession.sendText(item.content);
          sentCount += 1;
        } else if (item.type === "file" && item.file) {
          await activeSession.sendFile(
            item.file,
            item.burnAfterDownload,
            null,
            { name: item.name, mime: item.mime }
          );
          sentCount += 1;
        }
      } catch {
        // Lanjutkan jika satu item gagal
      }
    }
    syncHistoryBanner.classList.add("hidden");
    if (sentCount > 0) {
      showToast(`Riwayat sesi (${sentCount} item) berhasil dikirim.`);
    }
  });
}

function startCountdown(seconds) {
  clearInterval(timerInterval);
  remainingSeconds = Math.max(0, seconds);
  renderTimer();
  timerInterval = setInterval(() => {
    remainingSeconds = Math.max(0, remainingSeconds - 1);
    renderTimer();
    if (remainingSeconds <= 0) {
      clearInterval(timerInterval);
      if (activeRoomRole === "host" && activeSession) {
        activeSession.notifyRoomExpired();
      }
      resetToLobby("Waktu ruangan 10 menit telah habis.");
    }
  }, 1000);
}

function renderTimer() {
  const m = String(Math.floor(remainingSeconds / 60)).padStart(2, "0");
  const s = String(remainingSeconds % 60).padStart(2, "0");
  timerBadge.textContent = `${m}:${s}`;
}

function resetToLobby(notice) {
  clearInterval(timerInterval);
  closePreviewModal();
  clearPendingQueue();
  if (activeSession) {
    activeSession.cleanup();
    activeSession = null;
  }
  for (const url of blobUrls.values()) {
    URL.revokeObjectURL(url);
  }
  blobUrls.clear();
  sessionHistory = [];

  activeRoomCode = null;
  activeRoomRole = null;
  activeJoinUrl = "";
  hasQrSvg = false;
  feedItemCount = 0;
  dragDepth = 0;
  transferFeed.innerHTML = "";
  updateEmptyState();

  burnToggle.checked = false;
  burnToggleLabel.classList.remove("active");
  globalDropOverlay.classList.add("hidden");
  connectionPill.classList.add("hidden");
  connectionHelpBox.classList.add("hidden");
  syncHistoryBanner.classList.add("hidden");
  roomView.classList.add("hidden");
  lobbyView.classList.remove("hidden");

  const cleanUrl = window.location.pathname;
  window.history.replaceState({}, "", cleanUrl);

  if (notice) {
    showToast(notice);
  }
}

function appendFileCard({ id, name, size, direction, burnAfterDownload }) {
  feedItemCount += 1;
  updateEmptyState();

  const row = document.createElement("div");
  row.className = `msg-row ${direction}`;
  row.id = `item-${id}`;

  const burnBadge = burnAfterDownload
    ? `<span class="burn-tag">Sekali unduh</span>`
    : "";

  row.innerHTML = `
    <div class="bubble file-bubble">
      <div class="file-header">
        <div class="file-meta-col">
          <div class="file-name">${escapeHtml(name)}</div>
          <div class="file-sub">
            <span>${formatBytes(size)}</span>
            <span id="speed-${id}">Memulai...</span>
            ${burnBadge}
          </div>
        </div>
        <div class="file-actions" id="actions-${id}"></div>
      </div>
      <div class="preview-slot" id="preview-${id}"></div>
      <div class="progress-track" id="track-${id}">
        <div class="progress-fill" id="progress-${id}"></div>
      </div>
    </div>
    <div class="bubble-footer">
      <span>${formatTimeNow()}</span>
    </div>
  `;

  transferFeed.appendChild(row);
  scrollStreamToBottom();
}

function updateFileProgress(id, loaded, total, speedBps) {
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 100;
  const bar = document.getElementById(`progress-${id}`);
  const track = document.getElementById(`track-${id}`);
  const speedEl = document.getElementById(`speed-${id}`);

  if (bar) {
    bar.style.width = `${pct}%`;
  }
  if (pct >= 100 && track) {
    track.classList.add("hidden");
  }
  if (speedEl) {
    speedEl.textContent = pct >= 100 ? "Selesai" : `${pct}% (${formatBytes(speedBps)}/d)`;
  }
}

function appendTextCard({ id, content, direction }) {
  feedItemCount += 1;
  updateEmptyState();

  const row = document.createElement("div");
  row.className = `msg-row ${direction}`;
  row.id = `item-${id}`;

  row.innerHTML = `
    <div class="bubble">
      <div class="text-bubble-content">${linkifyEscapedText(content)}</div>
    </div>
    <div class="bubble-footer">
      <span>${formatTimeNow()}</span>
      <button type="button" class="subtle-copy-btn">Salin</button>
    </div>
  `;

  row.querySelector(".subtle-copy-btn").addEventListener("click", () => {
    copyTextSafe(content, "Teks disalin.");
  });

  transferFeed.appendChild(row);
  scrollStreamToBottom();
}

function enterRoomUI({ code, role, qrSvg, joinUrl, ttlSeconds }) {
  activeRoomCode = code;
  activeRoomRole = role;
  activeJoinUrl = joinUrl || buildJoinUrl(code);
  hasQrSvg = Boolean(qrSvg);

  lobbyError.classList.add("hidden");
  lobbyView.classList.add("hidden");
  roomView.classList.remove("hidden");
  roomCodeDisplay.textContent = code;
  startCountdown(ttlSeconds);

  if (hasQrSvg) {
    qrContainer.innerHTML = qrSvg;
  } else {
    qrContainer.innerHTML = "";
  }

  const host = window.location.hostname;
  const isLocalOnly = host === "127.0.0.1" || host === "localhost";
  localhostHint.classList.toggle("hidden", !isLocalOnly);

  setWorkspaceEnabled(false);

  activeSession = new DirectPeerSession({
    code,
    role,
    getRemainingSeconds: () => remainingSeconds,
    callbacks: {
      onJoined: ({ remainingSeconds: rem }) => {
        if (typeof rem === "number" && rem > 0) {
          startCountdown(rem);
        }
      },
      onStatusChange: (mode, text) => {
        setStatusPill(mode, text);
      },
      onChannelReady: (ready) => {
        setWorkspaceEnabled(ready);
        if (ready) {
          showToast("Terhubung langsung! Siap mengirim file atau teks.");
          maybeShowSyncBanner();
        }
      },
      onPeerDisconnected: () => {
        setWorkspaceEnabled(false);
        showToast("Perangkat lawan terputus.");
      },
      onIceTrouble: () => {
        connectionHelpBox.classList.remove("hidden");
      },
      onError: (errCode) => {
        if (errCode === "code_taken" && role === "host") {
          handleCreateRoom();
          return;
        }
        const msgMap = {
          room_not_found: "Ruangan tidak ditemukan atau pembuat ruangan sudah keluar.",
          room_full: "Ruangan ini sudah penuh (maksimal 2 perangkat).",
          peer_sdk_missing: "Gagal memuat layanan koneksi P2P. Periksa koneksi internetmu.",
        };
        resetToLobby(msgMap[errCode] || "Gagal terhubung ke ruangan.");
      },
      onRoomDestroyed: (reason) => {
        resetToLobby(reason);
      },
      onTextReceived: (msg) => {
        sessionHistory.push({ type: "text", id: msg.id, content: msg.content });
        appendTextCard({ id: msg.id, content: msg.content, direction: "in" });
      },
      onFileIncomingStart: (meta) => {
        appendFileCard({
          id: meta.id,
          name: meta.name,
          size: meta.size,
          direction: "in",
          burnAfterDownload: meta.burnAfterDownload,
        });
      },
      onFileProgress: (id, loaded, total, speedBps) => {
        updateFileProgress(id, loaded, total, speedBps);
      },
      onFileIncomingComplete: (meta, blob) => {
        updateFileProgress(meta.id, meta.size, meta.size, 0);
        const url = URL.createObjectURL(blob);
        blobUrls.set(meta.id, url);

        sessionHistory.push({
          type: "file",
          id: meta.id,
          file: blob,
          name: meta.name,
          mime: meta.mime,
          burnAfterDownload: meta.burnAfterDownload,
        });

        attachFilePreview(meta.id, {
          url,
          name: meta.name,
          mime: meta.mime,
          direction: "in",
          burnAfterDownload: meta.burnAfterDownload,
        });

        const actionsEl = document.getElementById(`actions-${meta.id}`);
        if (!actionsEl) return;

        const dlBtn = document.createElement("button");
        dlBtn.type = "button";
        dlBtn.className = "btn btn-primary btn-sm";
        dlBtn.textContent = meta.burnAfterDownload ? "Unduh & Hapus" : "Unduh";

        dlBtn.addEventListener("click", () => {
          const a = document.createElement("a");
          a.href = url;
          a.download = meta.name;
          document.body.appendChild(a);
          a.click();
          a.remove();

          if (meta.burnAfterDownload) {
            setTimeout(() => {
              URL.revokeObjectURL(url);
              blobUrls.delete(meta.id);
              sessionHistory = sessionHistory.filter((item) => item.id !== meta.id);
              const card = document.getElementById(`item-${meta.id}`);
              if (card) {
                card.remove();
                feedItemCount = Math.max(0, feedItemCount - 1);
                updateEmptyState();
              }
              activeSession?.notifyFileBurned(meta.id);
              showToast(`File "${meta.name}" diunduh dan dihapus.`);
            }, 300);
          }
        });

        actionsEl.appendChild(dlBtn);
        showToast(`File diterima: ${meta.name}`);
      },
      onPeerBurnedFile: (fileId) => {
        sessionHistory = sessionHistory.filter((item) => item.id !== fileId);
        const oldUrl = blobUrls.get(fileId);
        if (oldUrl) {
          URL.revokeObjectURL(oldUrl);
          blobUrls.delete(fileId);
        }
        const previewSlot = document.getElementById(`preview-${fileId}`);
        if (previewSlot) previewSlot.innerHTML = "";
        const actionsEl = document.getElementById(`actions-${fileId}`);
        if (actionsEl) actionsEl.innerHTML = "";
        const speedEl = document.getElementById(`speed-${fileId}`);
        if (speedEl) {
          speedEl.textContent = "Sudah diunduh & dihapus";
        }
        showToast("File sekali-unduh telah dibuka dan dihapus otomatis.");
      },
    },
  });

  activeSession.connect();
}

function handleCreateRoom() {
  lobbyError.classList.add("hidden");
  const code = generateRoomCode();
  const joinUrl = buildJoinUrl(code);
  const qrSvg = generateQrSvgClient(joinUrl);

  enterRoomUI({
    code,
    role: "host",
    qrSvg,
    joinUrl,
    ttlSeconds: ROOM_TTL_SECONDS,
  });
}

function handleJoinRoom(rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
    lobbyError.textContent = "Masukkan 6 karakter kode ruangan yang valid.";
    lobbyError.classList.remove("hidden");
    return;
  }

  lobbyError.classList.add("hidden");
  enterRoomUI({
    code,
    role: "guest",
    qrSvg: null,
    joinUrl: buildJoinUrl(code),
    ttlSeconds: ROOM_TTL_SECONDS,
  });
}

function enqueueFiles(filesArray, burn) {
  if (!activeSession || !activeSession.isReady()) {
    showToast("Tunggu perangkat kedua terhubung terlebih dahulu.");
    return;
  }
  for (const file of filesArray) {
    sendQueue = sendQueue.then(async () => {
      if (!activeSession || !activeSession.isReady()) return;
      let createdCardId = null;
      const localUrl = URL.createObjectURL(file);

      try {
        const meta = await activeSession.sendFile(file, burn, (id, sent, total, speed) => {
          if (!createdCardId) {
            createdCardId = id;
            blobUrls.set(id, localUrl);
            appendFileCard({
              id,
              name: file.name,
              size: file.size,
              direction: "out",
              burnAfterDownload: burn,
            });
            attachFilePreview(id, {
              url: localUrl,
              name: file.name,
              mime: file.type,
              direction: "out",
              burnAfterDownload: burn,
            });
          }
          updateFileProgress(id, sent, total, speed);
        });

        if (!createdCardId) {
          createdCardId = meta.id;
          blobUrls.set(meta.id, localUrl);
          appendFileCard({
            id: meta.id,
            name: meta.name,
            size: meta.size,
            direction: "out",
            burnAfterDownload: burn,
          });
          attachFilePreview(meta.id, {
            url: localUrl,
            name: meta.name,
            mime: meta.mime,
            direction: "out",
            burnAfterDownload: burn,
          });
          updateFileProgress(meta.id, meta.size, meta.size, 0);
        }

        sessionHistory.push({
          type: "file",
          id: meta.id,
          file,
          name: meta.name,
          mime: meta.mime,
          burnAfterDownload: burn,
        });
      } catch (err) {
        URL.revokeObjectURL(localUrl);
        showToast(err.message || `Gagal mengirim ${file.name}`);
      }
    });
  }
}

function autoResizeTextarea() {
  textInput.style.height = "auto";
  const nextHeight = Math.min(textInput.scrollHeight, 120);
  textInput.style.height = `${nextHeight}px`;
  textInput.style.overflowY = textInput.scrollHeight > 120 ? "auto" : "hidden";
}

function bindEvents() {
  createRoomBtn.addEventListener("click", handleCreateRoom);

  joinRoomForm.addEventListener("submit", (e) => {
    e.preventDefault();
    handleJoinRoom(joinCodeInput.value);
  });

  copyCodeBtn.addEventListener("click", () => {
    if (activeRoomCode) copyTextSafe(activeRoomCode, "Kode ruangan disalin.");
  });

  copyLinkBtn.addEventListener("click", () => {
    if (activeJoinUrl) copyTextSafe(activeJoinUrl, "Tautan ruangan disalin.");
  });

  qrToggleBtn.addEventListener("click", () => {
    const isHidden = qrSection.classList.contains("hidden");
    setQrVisible(isHidden);
  });

  reconnectBtn.addEventListener("click", () => {
    if (!activeSession) return;
    connectionHelpBox.classList.add("hidden");
    showToast("Mencoba menyambung ulang jalur langsung...");
    activeSession.retryConnection();
  });

  syncHistoryBtn.addEventListener("click", handleSyncHistory);
  dismissSyncBtn.addEventListener("click", () => {
    syncHistoryBanner.classList.add("hidden");
  });

  clearQueueBtn.addEventListener("click", clearPendingQueue);

  closePreviewBtn.addEventListener("click", closePreviewModal);
  previewModal.addEventListener("click", (e) => {
    if (e.target === previewModal) closePreviewModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !previewModal.classList.contains("hidden")) {
      closePreviewModal();
    }
  });

  destroyRoomBtn.addEventListener("click", () => {
    if (activeSession) {
      activeSession.requestDestroyRoom();
    }
    resetToLobby("Ruangan ditutup dan seluruh data telah dihapus.");
  });

  attachFileBtn.addEventListener("click", () => {
    if (!attachFileBtn.disabled) {
      fileInput.click();
    }
  });

  burnToggle.addEventListener("change", () => {
    burnToggleLabel.classList.toggle("active", burnToggle.checked);
    renderPendingQueue();
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length > 0) {
      addFilesToPendingQueue(e.target.files);
      fileInput.value = "";
    }
  });

  window.addEventListener("dragenter", (e) => {
    if (!activeSession || !activeSession.isReady()) return;
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepth += 1;
    globalDropOverlay.classList.remove("hidden");
  });

  window.addEventListener("dragover", (e) => {
    if (!activeSession || !activeSession.isReady()) return;
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
  });

  window.addEventListener("dragleave", () => {
    if (dragDepth === 0) return;
    dragDepth -= 1;
    if (dragDepth <= 0) {
      dragDepth = 0;
      globalDropOverlay.classList.add("hidden");
    }
  });

  window.addEventListener("drop", (e) => {
    if (!activeSession || !activeSession.isReady()) return;
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    globalDropOverlay.classList.add("hidden");
    addFilesToPendingQueue(e.dataTransfer.files);
  });

  textInput.addEventListener("input", autoResizeTextarea);

  textForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!activeSession || !activeSession.isReady()) return;

    const content = textInput.value.trim();
    const hasFiles = pendingFiles.length > 0;
    if (!content && !hasFiles) return;

    if (content) {
      const sent = activeSession.sendText(content);
      if (sent) {
        sessionHistory.push({ type: "text", id: sent.id, content: sent.content });
        appendTextCard({ id: sent.id, content: sent.content, direction: "out" });
        textInput.value = "";
        autoResizeTextarea();
      }
    }

    if (hasFiles) {
      const filesToSend = pendingFiles.map((item) => item.file);
      const burn = burnToggle.checked;
      clearPendingQueue();
      enqueueFiles(filesToSend, burn);
    }
  });

  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      textForm.requestSubmit();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (activeSession) activeSession.cleanup();
  });
}

function bootstrap() {
  initTheme();
  bindEvents();

  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get("room");
  if (roomFromUrl) {
    joinCodeInput.value = roomFromUrl.toUpperCase().slice(0, 6);
    handleJoinRoom(roomFromUrl);
  }
}

bootstrap();