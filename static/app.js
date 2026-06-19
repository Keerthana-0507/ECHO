(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* ---------- STATE ---------- */
  const state = {
    model: document.body.dataset.defaultModel || "gemini-2.5-flash",
    persona: "",
    ttsEnabled: true,
    rate: 1,
    voiceURI: localStorage.getItem("echo_voice") || "",
    isListening: false,
    isSending: false,
    exchanges: 0,
  };

  /* ---------- DOM ---------- */
  const consoleEl   = $("console");
  const textInput   = $("textInput");
  const sendBtn     = $("sendBtn");
  const micBtn      = $("micBtn");
  const micHint     = $("micHint");
  const waveState   = $("waveState");
  const micStatus   = $("micStatus");
  const msgCount    = $("msgCount");
  const clockEl     = $("clock");

  const settingsBtn   = $("settingsBtn");
  const modalBackdrop = $("modalBackdrop");
  const closeModal    = $("closeModal");
  const saveSettings  = $("saveSettings");
  const modelSelect   = $("modelSelect");
  const personaInput  = $("personaInput");

  const ttsToggle   = $("ttsToggle");
  const rateSlider  = $("rateSlider");
  const voiceSelect = $("voiceSelect");
  const exportBtn   = $("exportBtn");
  const clearBtn    = $("clearBtn");

  /* ---------- CLOCK ---------- */
  function tickClock() { clockEl.textContent = new Date().toLocaleTimeString(); }
  setInterval(tickClock, 1000);
  tickClock();

  /* ---------- UTIL ---------- */
  function ts() {
    return new Date().toLocaleTimeString([], { hour12: false });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function appendLine(role, text, { typing = false } = {}) {
    const tagMap = { user: "YOU", bot: "ECHO", system: "SYS", error: "ERR" };
    const row = document.createElement("div");
    row.className = `console-line console-line--${role}`;
    row.innerHTML = `
      <span class="line-tag">${tagMap[role] || role.toUpperCase()}</span>
      <span class="line-text${typing ? " is-typing" : ""}">${escapeHtml(text)}</span>
      <span class="line-meta">${ts()}</span>
    `;
    consoleEl.appendChild(row);
    consoleEl.scrollTop = consoleEl.scrollHeight;
    return row.querySelector(".line-text");
  }

  function updateMsgCount(n) {
    if (typeof n === "number") state.exchanges = n;
    msgCount.textContent = `${state.exchanges} exchange${state.exchanges === 1 ? "" : "s"}`;
  }

  // Note: if no API key is configured server-side, the template already
  // renders a system message explaining this on page load — no need to
  // duplicate it here in JS.

  /* ---------- SETTINGS MODAL ---------- */
  function openModal() {
    modelSelect.value = state.model;
    personaInput.value = state.persona;
    modalBackdrop.classList.add("is-open");
  }
  function closeModalFn() { modalBackdrop.classList.remove("is-open"); }

  settingsBtn.addEventListener("click", openModal);
  closeModal.addEventListener("click", closeModalFn);
  modalBackdrop.addEventListener("click", (e) => { if (e.target === modalBackdrop) closeModalFn(); });

  saveSettings.addEventListener("click", () => {
    state.model = modelSelect.value;
    state.persona = personaInput.value.trim();
    closeModalFn();
    appendLine("system", "Settings saved for this session.");
  });

  /* ---------- TEXT-TO-SPEECH (browser native) ---------- */
  let voices = [];

  function loadVoices() {
    voices = speechSynthesis.getVoices();
    voiceSelect.innerHTML = "";
    voices
      .filter(v => v.lang.startsWith("en") || voices.length < 6)
      .forEach(v => {
        const opt = document.createElement("option");
        opt.value = v.voiceURI;
        opt.textContent = `${v.name} (${v.lang})`;
        voiceSelect.appendChild(opt);
      });
    if (state.voiceURI) voiceSelect.value = state.voiceURI;
  }
  speechSynthesis.addEventListener("voiceschanged", loadVoices);
  loadVoices();

  voiceSelect.addEventListener("change", () => {
    state.voiceURI = voiceSelect.value;
    localStorage.setItem("echo_voice", state.voiceURI);
  });

  ttsToggle.addEventListener("change", () => { state.ttsEnabled = ttsToggle.checked; });
  rateSlider.addEventListener("input", () => { state.rate = parseFloat(rateSlider.value); });

  function speak(text) {
    if (!state.ttsEnabled || !text) return;
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = state.rate;
    const chosen = voices.find(v => v.voiceURI === state.voiceURI);
    if (chosen) utter.voice = chosen;
    speechSynthesis.speak(utter);
  }

  /* ---------- SPEECH-TO-TEXT (browser native) ---------- */
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;

  if (SpeechRecognition) {
    recognizer = new SpeechRecognition();
    recognizer.lang = "en-US";
    recognizer.interimResults = true;
    recognizer.continuous = false;

    recognizer.onstart = () => {
      state.isListening = true;
      micBtn.classList.add("is-listening");
      micHint.textContent = "Listening… tap to stop";
      waveState.textContent = "LISTENING";
      micStatus.querySelector(".dot").className = "dot dot--live";
      micStatus.querySelector("span:last-child").textContent = "MIC: live";
    };

    recognizer.onresult = (event) => {
      let interim = "", final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += transcript;
        else interim += transcript;
      }
      textInput.value = (final || interim).trim();
      autoResize();
    };

    recognizer.onerror = (event) => {
      appendLine("error", `Speech recognition error: ${event.error}`);
      stopListening();
    };

    recognizer.onend = () => {
      stopListening();
      if (textInput.value.trim()) handleSend();
    };
  } else {
    micBtn.disabled = true;
    micHint.textContent = "Voice input unsupported in this browser";
  }

  function stopListening() {
    state.isListening = false;
    micBtn.classList.remove("is-listening");
    micHint.textContent = "Tap to speak";
    waveState.textContent = "SILENT";
    micStatus.querySelector(".dot").className = "dot dot--off";
    micStatus.querySelector("span:last-child").textContent = "MIC: idle";
    stopVisualizer();
  }

  micBtn.addEventListener("click", () => {
    if (!recognizer) return;
    if (state.isListening) {
      recognizer.stop();
    } else {
      textInput.value = "";
      try {
        recognizer.start();
        startVisualizer();
      } catch (e) {
        appendLine("error", "Could not start microphone: " + e.message);
      }
    }
  });

  /* ---------- WAVEFORM VISUALIZER ---------- */
  const canvas = $("waveCanvas");
  const ctx2d = canvas.getContext("2d");
  let audioCtx, analyser, micStream, rafId;

  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * devicePixelRatio;
    canvas.height = rect.height * devicePixelRatio;
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  async function startVisualizer() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      drawWave();
    } catch (e) {
      drawIdle();
    }
  }

  function stopVisualizer() {
    if (rafId) cancelAnimationFrame(rafId);
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (audioCtx) audioCtx.close().catch(() => {});
    drawIdle();
  }

  function drawWave() {
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function render() {
      rafId = requestAnimationFrame(render);
      analyser.getByteTimeDomainData(dataArray);
      const w = canvas.width, h = canvas.height;
      ctx2d.clearRect(0, 0, w, h);
      ctx2d.lineWidth = 2 * devicePixelRatio;
      ctx2d.strokeStyle = "#ffb454";
      ctx2d.shadowColor = "rgba(255,180,84,0.6)";
      ctx2d.shadowBlur = 6;
      ctx2d.beginPath();
      const slice = w / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * h) / 2;
        i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
        x += slice;
      }
      ctx2d.stroke();
    }
    render();
  }

  function drawIdle() {
    const w = canvas.width, h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.strokeStyle = "#2c7a4f";
    ctx2d.lineWidth = 1.5 * devicePixelRatio;
    ctx2d.beginPath();
    ctx2d.moveTo(0, h / 2);
    ctx2d.lineTo(w, h / 2);
    ctx2d.stroke();
  }
  drawIdle();

  /* ---------- TEXTAREA AUTO-RESIZE ---------- */
  function autoResize() {
    textInput.style.height = "auto";
    textInput.style.height = Math.min(textInput.scrollHeight, 120) + "px";
  }
  textInput.addEventListener("input", autoResize);
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  sendBtn.addEventListener("click", handleSend);

  /* ---------- BACKEND CALLS (Flask) ---------- */
  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  async function handleSend() {
    const text = textInput.value.trim();
    if (!text || state.isSending) return;

    textInput.value = "";
    autoResize();

    appendLine("user", text);
    state.isSending = true;
    sendBtn.disabled = true;
    const liveLine = appendLine("bot", "Thinking…", { typing: true });

    try {
      const data = await postJSON("/api/chat", {
        message: text,
        model: state.model,
        persona: state.persona,
      });
      liveLine.textContent = data.reply;
      liveLine.classList.remove("is-typing");
      liveLine.parentElement.querySelector(".line-meta").textContent = ts();
      updateMsgCount(data.exchanges);
      speak(data.reply);
    } catch (err) {
      liveLine.parentElement.classList.remove("console-line--bot");
      liveLine.parentElement.classList.add("console-line--error");
      liveLine.parentElement.querySelector(".line-tag").textContent = "ERR";
      liveLine.textContent = err.message;
      liveLine.classList.remove("is-typing");
    } finally {
      state.isSending = false;
      sendBtn.disabled = false;
    }
  }

  exportBtn.addEventListener("click", () => {
    window.location.href = "/api/export";
  });

  clearBtn.addEventListener("click", async () => {
    if (!confirm("Clear the entire conversation? This cannot be undone.")) return;
    try {
      await postJSON("/api/clear");
      consoleEl.innerHTML = "";
      appendLine("system", "Conversation cleared.");
      updateMsgCount(0);
    } catch (err) {
      appendLine("error", "Could not clear conversation: " + err.message);
    }
  });
})();
