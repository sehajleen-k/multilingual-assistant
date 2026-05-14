const API_BASE = "http://localhost:8000";
const SESSION_ID = crypto.randomUUID();

// ── State ─────────────────────────────────────────────────────────────────────
let appState = "idle";
let mediaRecorder = null;
let audioChunks = [];
let isProcessing = false;

let audioCtx = null;
let micAnalyser = null;
let ttsAnalyser = null;
let ttsSource = null;   // keep reference so we can stop it
let animFrameId = null;

const NUM_BARS = 64;
let smoothedBars = new Float32Array(NUM_BARS);

// ── Attachment state ──────────────────────────────────────────────────────────
let attachedFile = null;  // File object or null

// ── Elements ──────────────────────────────────────────────────────────────────
const canvas        = document.getElementById("waveform");
const ctx2d         = canvas.getContext("2d");
const stateLabel    = document.getElementById("state-label");
const stopBtn       = document.getElementById("stop-btn");
const talkBtn       = document.getElementById("talk-btn");
const resetBtn      = document.getElementById("reset-btn");
const attachBtn     = document.getElementById("attach-btn");
const fileInput     = document.getElementById("file-input");
const attachBar     = document.getElementById("attachment-bar");
const attachName    = document.getElementById("attachment-name");
const attachRemove  = document.getElementById("attachment-remove");
const textInput     = document.getElementById("text-context");
const languageSelect = document.getElementById("language-select");
const transcript    = document.getElementById("transcript");
const correctionsPanel = document.getElementById("corrections-panel");
const correctionsList  = document.getElementById("corrections-list");

// ── Tab elements ───────────────────────────────────────────────────────────────
const tutorContent  = document.querySelector(".tutor-content");
const docContent    = document.querySelector(".doc-content");
const tabBtns       = document.querySelectorAll(".tab");

// ── Doc tab elements ───────────────────────────────────────────────────────────
const methodBtns    = document.querySelectorAll(".method-btn");
const docInputAreas = document.querySelectorAll(".doc-input-area");
const docFileInput  = document.getElementById("doc-file");
const docFileZone   = document.getElementById("doc-file-zone");
const docFileLabel  = document.getElementById("doc-file-label");
const analyzeBtn    = document.getElementById("analyze-btn");

let currentTab    = "tutor";
let currentMethod = "text";

// ── Canvas ────────────────────────────────────────────────────────────────────
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;
}
window.addEventListener("resize", () => { resizeCanvas(); });
resizeCanvas();

// ── AudioContext ──────────────────────────────────────────────────────────────
function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

// ── State machine ─────────────────────────────────────────────────────────────
function setState(newState) {
  appState = newState;
  stateLabel.textContent = newState;
  stateLabel.className = `state-label ${newState === "idle" ? "" : newState}`;

  // Show/hide stop button
  if (newState === "speaking") {
    stopBtn.classList.remove("hidden");
  } else {
    stopBtn.classList.add("hidden");
  }

  if (animFrameId) cancelAnimationFrame(animFrameId);
  smoothedBars = new Float32Array(NUM_BARS);

  switch (newState) {
    case "idle":       loopIdle(); break;
    case "listening":  loopBars(() => micAnalyser, "#6366f1", "#a78bfa"); break;
    case "processing": loopProcessing(); break;
    case "speaking":   loopBars(() => ttsAnalyser, "#8b5cf6", "#c4b5fd"); break;
  }
}

// ── Drawing ───────────────────────────────────────────────────────────────────
function clearCanvas() {
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
}

function drawBarFrame(colorA, colorB) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width, H = canvas.height;
  clearCanvas();
  const barW = 3 * dpr, gap = 3 * dpr, step = barW + gap;
  const totalW = NUM_BARS * step - gap;
  const startX = (W - totalW) / 2;
  const centerY = H / 2, maxH = (H / 2) * 0.88;
  const grad = ctx2d.createLinearGradient(startX, 0, startX + totalW, 0);
  grad.addColorStop(0, colorA); grad.addColorStop(1, colorB);
  ctx2d.fillStyle = grad;
  for (let i = 0; i < NUM_BARS; i++) {
    const x = startX + i * step;
    const h = Math.max(2 * dpr, smoothedBars[i] * maxH);
    const r = Math.min(barW / 2, h / 2);
    ctx2d.beginPath();
    ctx2d.roundRect(x, centerY - h, barW, h * 2, r);
    ctx2d.fill();
  }
}

let idleT = 0;
function loopIdle() {
  function frame(ts) {
    animFrameId = requestAnimationFrame(frame);
    idleT = ts * 0.0008;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width, H = canvas.height;
    clearCanvas();
    ctx2d.beginPath();
    ctx2d.strokeStyle = "#e0e0e0";
    ctx2d.lineWidth = 2 * dpr;
    ctx2d.lineJoin = "round";
    for (let x = 0; x <= W; x += 2) {
      const norm = x / W;
      const y = H / 2 + Math.sin(norm * Math.PI * 5 + idleT) * 6 * dpr
                      + Math.sin(norm * Math.PI * 2 + idleT * 0.6) * 3 * dpr;
      x === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
  }
  animFrameId = requestAnimationFrame(frame);
}

function loopBars(getAnalyser, colorA, colorB) {
  const dataArray = new Uint8Array(256);
  function frame() {
    animFrameId = requestAnimationFrame(frame);
    const analyser = getAnalyser();
    if (!analyser) return;
    analyser.getByteFrequencyData(dataArray);
    const binCount = analyser.frequencyBinCount;
    for (let i = 0; i < NUM_BARS; i++) {
      const bi = Math.floor((i / NUM_BARS) * binCount * 0.75);
      smoothedBars[i] = smoothedBars[i] * 0.72 + (dataArray[bi] / 255) * 0.28;
    }
    drawBarFrame(colorA, colorB);
  }
  animFrameId = requestAnimationFrame(frame);
}

function loopProcessing() {
  let t = 0;
  function frame() {
    animFrameId = requestAnimationFrame(frame);
    t += 0.025;
    for (let i = 0; i < NUM_BARS; i++) {
      const norm = i / NUM_BARS;
      const target = 0.08 + Math.sin(norm * Math.PI * 4 - t) * 0.06
                          + Math.sin(norm * Math.PI * 1.5 + t * 0.7) * 0.04;
      smoothedBars[i] = smoothedBars[i] * 0.85 + target * 0.15;
    }
    drawBarFrame("#aaaaaa", "#cccccc");
  }
  animFrameId = requestAnimationFrame(frame);
}

// ── Stop button ───────────────────────────────────────────────────────────────
stopBtn.addEventListener("click", () => {
  if (ttsSource) {
    ttsSource.onended = null;  // prevent the onended callback from firing
    ttsSource.stop();
    ttsSource = null;
    ttsAnalyser = null;
  }
  setState("idle");
  isProcessing = false;
  talkBtn.classList.remove("processing");
});

// ── Recording ─────────────────────────────────────────────────────────────────
talkBtn.addEventListener("mousedown", startRecording);
talkBtn.addEventListener("touchstart", (e) => { e.preventDefault(); startRecording(); });
talkBtn.addEventListener("mouseup", stopAndSend);
talkBtn.addEventListener("mouseleave", stopAndSend);
talkBtn.addEventListener("touchend", stopAndSend);

async function startRecording() {
  if (isProcessing || mediaRecorder?.state === "recording") return;
  const ctx = ensureAudioCtx();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    const micSource = ctx.createMediaStreamSource(stream);
    micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 512;
    micAnalyser.smoothingTimeConstant = 0.8;
    micSource.connect(micAnalyser);

    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      micAnalyser = null;
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      await sendTurn(blob);
    };
    mediaRecorder.start();
    talkBtn.classList.add("recording");
    setState("listening");
  } catch {
    setState("idle");
    appendError("Microphone access denied.");
  }
}

function stopAndSend() {
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    talkBtn.classList.remove("recording");
  }
}

// ── File attachment ───────────────────────────────────────────────────────────
attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  attachedFile = file;
  attachName.textContent = file.name;
  attachBar.classList.remove("hidden");
  attachBtn.classList.add("has-file");
  fileInput.value = "";
});

attachRemove.addEventListener("click", clearAttachment);

function clearAttachment() {
  attachedFile = null;
  attachBar.classList.add("hidden");
  attachBtn.classList.remove("has-file");
}

// Prevent Enter from submitting anything; text is sent with next voice turn
textInput.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });

// ── API call ──────────────────────────────────────────────────────────────────
async function sendTurn(audioBlob) {
  if (isProcessing) return;
  isProcessing = true;
  talkBtn.classList.add("processing");
  setState("processing");
  hideCorrections();

  const formData = new FormData();
  formData.append("audio", audioBlob, "audio.webm");
  formData.append("session_id", SESSION_ID);
  formData.append("language", languageSelect.value);
  if (attachedFile) formData.append("attachment", attachedFile, attachedFile.name);
  const typedContext = textInput.value.trim();
  if (typedContext) formData.append("text_context", typedContext);

  // Snapshot and clear the attachment + text input before the request
  const sentFile = attachedFile;
  clearAttachment();
  textInput.value = "";

  try {
    const res = await fetch(`${API_BASE}/turn`, { method: "POST", body: formData });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Server error");
    }
    const data = await res.json();

    appendMessage("user", data.user_transcript, sentFile);
    appendMessage("tutor", data.tutor_text);
    if (data.corrections?.length) showCorrections(data.corrections);
    await playAudioWithViz(data.audio_b64);
  } catch (err) {
    appendError(err.message);
    setState("idle");
  } finally {
    isProcessing = false;
    talkBtn.classList.remove("processing");
  }
}

// ── TTS playback ──────────────────────────────────────────────────────────────
async function playAudioWithViz(b64) {
  const ctx = ensureAudioCtx();
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;

  ttsAnalyser = ctx.createAnalyser();
  ttsAnalyser.fftSize = 512;
  ttsAnalyser.smoothingTimeConstant = 0.8;
  source.connect(ttsAnalyser);
  ttsAnalyser.connect(ctx.destination);

  ttsSource = source;
  setState("speaking");
  source.start(0);

  return new Promise((resolve) => {
    source.onended = () => {
      ttsSource = null;
      ttsAnalyser = null;
      setState("idle");
      resolve();
    };
  });
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function appendMessage(role, text, file = null) {
  const msg = document.createElement("div");
  msg.className = `message ${role}`;

  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = role === "user" ? "you" : "tutor";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  // Show file preview in bubble if present
  if (file) {
    if (file.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "attachment-thumb";
      img.src = URL.createObjectURL(file);
      bubble.appendChild(img);
    } else {
      const docRow = document.createElement("div");
      docRow.className = "attachment-doc";
      docRow.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ${file.name}`;
      bubble.appendChild(docRow);
    }
  }

  const textNode = document.createElement("span");
  textNode.textContent = text;
  bubble.appendChild(textNode);

  msg.appendChild(label);
  msg.appendChild(bubble);
  transcript.appendChild(msg);
  msg.scrollIntoView({ behavior: "smooth", block: "end" });
}

function appendError(msg) {
  const el = document.createElement("p");
  el.style.cssText = "color:#ef4444;font-size:13px;text-align:center;padding:8px 0";
  el.textContent = msg;
  transcript.appendChild(el);
}

function showCorrections(corrections) {
  correctionsList.innerHTML = "";
  corrections.forEach((c) => {
    const li = document.createElement("li");
    li.textContent = c;
    correctionsList.appendChild(li);
  });
  correctionsPanel.classList.remove("hidden");
}

function hideCorrections() {
  correctionsPanel.classList.add("hidden");
  correctionsList.innerHTML = "";
}

// ── Reset ─────────────────────────────────────────────────────────────────────
resetBtn.addEventListener("click", async () => {
  if (ttsSource) { ttsSource.onended = null; ttsSource.stop(); ttsSource = null; }
  await fetch(`${API_BASE}/reset`, {
    method: "POST",
    body: new URLSearchParams({ session_id: SESSION_ID }),
  });
  transcript.innerHTML = "";
  hideCorrections();
  clearAttachment();
  setState("idle");
});

// ── Tab switching ──────────────────────────────────────────────────────────────
tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentTab = btn.dataset.tab;
    tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
    tutorContent.classList.toggle("hidden", currentTab !== "tutor");
    docContent.classList.toggle("hidden", currentTab !== "doc");
    hideCorrections();
  });
});

// ── Doc: input method switching ────────────────────────────────────────────────
methodBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentMethod = btn.dataset.method;
    methodBtns.forEach((b) => b.classList.toggle("active", b === btn));
    docInputAreas.forEach((area) => {
      area.classList.toggle("hidden", area.dataset.input !== currentMethod);
    });
  });
});

// Doc file zone click
docFileZone.addEventListener("click", () => docFileInput.click());
docFileInput.addEventListener("change", () => {
  const file = docFileInput.files[0];
  if (file) {
    docFileZone.classList.add("has-file");
    docFileLabel.textContent = file.name;
  }
});

// ── Doc: analyze ───────────────────────────────────────────────────────────────
analyzeBtn.addEventListener("click", analyzeDoc);

async function analyzeDoc() {
  if (isProcessing) return;

  const types = Array.from(
    document.querySelectorAll(".analysis-types input:checked")
  ).map((cb) => cb.value);
  if (!types.length) { appendError("Select at least one analysis type."); return; }

  const formData = new FormData();
  formData.append("session_id", SESSION_ID);
  formData.append("language", languageSelect.value);
  formData.append("analysis_types", types.join(","));

  if (currentMethod === "text") {
    const text = document.getElementById("doc-text").value.trim();
    if (!text) { appendError("Please paste some text first."); return; }
    formData.append("text", text);
  } else if (currentMethod === "file") {
    const file = docFileInput.files[0];
    if (!file) { appendError("Please select a file first."); return; }
    formData.append("file", file, file.name);
  } else if (currentMethod === "url") {
    const url = document.getElementById("doc-url").value.trim();
    if (!url) { appendError("Please enter a URL first."); return; }
    formData.append("url", url);
  }

  isProcessing = true;
  analyzeBtn.disabled = true;
  talkBtn.classList.add("processing");
  setState("processing");
  hideCorrections();

  try {
    const res = await fetch(`${API_BASE}/doc/analyze`, { method: "POST", body: formData });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Server error");
    }
    const data = await res.json();
    appendMessage("tutor", data.analysis_text);
    await playAudioWithViz(data.audio_b64);
  } catch (err) {
    appendError(err.message);
    setState("idle");
  } finally {
    isProcessing = false;
    analyzeBtn.disabled = false;
    talkBtn.classList.remove("processing");
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
setState("idle");
