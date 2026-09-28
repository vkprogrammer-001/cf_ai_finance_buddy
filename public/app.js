// FinBuddy chat client — plain JS, no build step.
const $ = (id) => document.getElementById(id);
const els = {
  messages: $("messages"),
  form: $("composer"),
  input: $("input"),
  send: $("send"),
  mic: $("mic"),
  suggestions: $("suggestions"),
  summary: $("summary"),
  profile: $("profile"),
  status: $("status"),
  insights: $("insights"),
  reset: $("reset"),
  sessionId: $("session-id"),
  memory: $("memory"),
  toggleMemory: $("toggle-memory"),
  closeMemory: $("close-memory")
};

// ---- session: one Durable Object per browser (persisted in localStorage) ----
function getSessionId() {
  const fromUrl = new URLSearchParams(location.search).get("session");
  if (fromUrl) return fromUrl;
  try {
    let id = localStorage.getItem("finbuddy-session");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("finbuddy-session", id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
const session = getSessionId();
const base = `/agents/finance-buddy/${encodeURIComponent(session)}`;
els.sessionId.textContent = session.slice(0, 8);

// ---- rendering ----
function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

const labels = {
  goals: "Goals",
  riskAppetite: "Risk appetite",
  investmentHorizon: "Horizon",
  experienceLevel: "Level",
  topicsCovered: "Topics covered",
  openQuestions: "Open questions"
};

let pollTimer = null;
function renderState(state) {
  if (!state) return;
  els.summary.textContent = state.summary || "Nothing yet — start chatting.";
  els.profile.innerHTML = "";
  for (const [key, label] of Object.entries(labels)) {
    const value = state.profile?.[key];
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = Array.isArray(value) ? (value.length ? value.join(", ") : "—") : value || "—";
    els.profile.append(dt, dd);
  }
  const status = state.insights?.status ?? "idle";
  els.status.textContent =
    status === "running" ? "updating memory…" : status === "error" ? "memory update failed" : "up to date";
  els.status.className = `badge ${status}`;
  els.insights.disabled = status === "running";

  // While the Workflow runs, poll the Agent's state until it finishes.
  if (status === "running" && !pollTimer) {
    pollTimer = setInterval(refreshState, 2500);
  } else if (status !== "running" && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function refreshState() {
  try {
    const res = await fetch(`${base}/state`);
    const data = await res.json();
    renderState(data.state);
  } catch (e) {
    console.warn("state refresh failed", e);
  }
}

async function loadHistory() {
  const res = await fetch(`${base}/history`);
  const data = await res.json();
  els.messages.innerHTML = "";
  if (!data.messages?.length) {
    addMessage("assistant", "Hi! I'm FinBuddy 👋 Ask me anything about mutual funds, SIPs or investing basics. Tell me your goals and I'll remember them.");
  } else {
    els.suggestions.hidden = true;
    for (const m of data.messages) addMessage(m.role, m.content);
  }
  renderState(data.state);
}

// ---- chat ----
let busy = false;
async function sendMessage(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  els.send.disabled = true;
  els.suggestions.hidden = true;
  addMessage("user", text);
  els.input.value = "";
  autosize();

  const bubble = addMessage("assistant", "");
  bubble.classList.add("typing");
  try {
    const res = await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text })
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bubble.textContent += value;
      els.messages.scrollTop = els.messages.scrollHeight;
    }
  } catch (e) {
    bubble.textContent = `Something went wrong: ${e.message}`;
  } finally {
    bubble.classList.remove("typing");
    busy = false;
    els.send.disabled = false;
    els.input.focus();
    setTimeout(refreshState, 800); // the Agent may have started the Workflow
  }
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(els.input.value);
});
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(els.input.value);
  }
});
function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
}
els.input.addEventListener("input", autosize);
els.suggestions.addEventListener("click", (e) => {
  if (e.target.classList.contains("chip")) sendMessage(e.target.textContent);
});

// ---- memory controls ----
els.insights.addEventListener("click", async () => {
  els.insights.disabled = true;
  const res = await fetch(`${base}/insights`, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  renderState(data.state);
});
els.reset.addEventListener("click", async () => {
  if (!window.confirm("Forget this conversation and everything FinBuddy learned about you?")) return;
  await fetch(`${base}/reset`, { method: "POST" });
  els.suggestions.hidden = false;
  await loadHistory();
});
els.toggleMemory.addEventListener("click", () => els.memory.classList.add("open"));
els.closeMemory.addEventListener("click", () => els.memory.classList.remove("open"));

// ---- voice input (Web Speech API, where supported) ----
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!Recognition) {
  els.mic.hidden = true;
} else {
  const rec = new Recognition();
  rec.lang = "en-IN";
  rec.interimResults = true;
  let listening = false;
  rec.onresult = (e) => {
    els.input.value = Array.from(e.results).map((r) => r[0].transcript).join("");
    autosize();
    if (e.results[e.results.length - 1].isFinal) sendMessage(els.input.value);
  };
  rec.onend = () => {
    listening = false;
    els.mic.classList.remove("listening");
  };
  els.mic.addEventListener("click", () => {
    if (listening) return rec.stop();
    listening = true;
    els.mic.classList.add("listening");
    rec.start();
  });
}

loadHistory().catch((e) => addMessage("assistant", `Could not load session: ${e.message}`));
