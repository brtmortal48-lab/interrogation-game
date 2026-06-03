const socket = io();

let roomId = "";
let players = [];
let statements = [];

window.onload = () => {
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get("room");

  if (roomFromUrl) {
    document.getElementById("room").value = roomFromUrl.toUpperCase();
    joinOverlay();
  }
};

function joinOverlay() {
  roomId = document.getElementById("room").value.trim().toUpperCase();
  if (!roomId) return alert("Enter room code.");

  socket.emit("joinRoom", { roomId, role: "overlay" });
  document.querySelector(".overlayRoom").style.display = "none";
}

socket.on("roomUpdate", (data) => {
  players = data.players || [];

  document.getElementById("roundNumber").innerText = data.roundNumber || 0;
  document.getElementById("playerCount").innerText = players.length;

  renderSusBoard();
  renderVoteBoard(data.viewerVotes || []);
  renderDirector(data.detectiveDirector || []);
  renderIntensity(data.caseIntensity);
  renderDirector(data.detectiveDirector || []);
  renderIntensity(data.caseIntensity);
});

socket.on("roundStarted", (data) => {
  players = data.players || [];
  statements = [];

  document.getElementById("roundNumber").innerText = data.roundNumber;
  document.getElementById("timer").innerText = formatTime(data.timeLeft);
  const conflict = data.caseFile?.conflictingDetail ? ` • ${data.caseFile.conflictingDetail}` : "";
  document.getElementById("incident").innerText = `${data.incidentTitle}${conflict}`;
  document.getElementById("accused").innerText = "None";
  document.getElementById("focus").innerText = "Investigating";
  document.getElementById("twist").innerText = "";
  document.getElementById("result").innerText = "";
  hideEventBanner();
  document.getElementById("liveStatements").innerHTML = "";
  const contradictionBox = document.getElementById("broadcastContradictions");
  if (contradictionBox) contradictionBox.innerHTML = "";

  renderSusBoard();
  renderVoteBoard(data.viewerVotes || []);
  renderDirector(data.detectiveDirector || []);
  renderIntensity(data.caseIntensity);
});

socket.on("suspicionUpdate", (data) => {
  players = data.players || [];
  renderSusBoard();
  renderDirector(data.detectiveDirector || []);
  renderIntensity(data.caseIntensity);
});

socket.on("voteUpdate", (data) => {
  renderVoteBoard(data.viewerVotes || []);
  renderDirector(data.detectiveDirector || []);
  renderIntensity(data.caseIntensity);
});

socket.on("timerUpdate", (timeLeft) => {
  document.getElementById("timer").innerText = formatTime(timeLeft);
});

socket.on("midEvidenceDrop", (e) => {
  document.getElementById("twist").innerText = `🚨 New Evidence Recovered: ${e.text}`;
  document.getElementById("focus").innerText = "New Evidence";
});

socket.on("spotlight", (data) => {
  document.getElementById("focus").innerText = `${data.playerName} Under Pressure`;
});

socket.on("spotlightEnd", () => {
  document.getElementById("focus").innerText = "Investigating";
});

socket.on("accusation", (data) => {
  document.getElementById("accused").innerText = data.playerName;
  document.getElementById("focus").innerText = "Final Accusation";
});

socket.on("contradictionFound", (data) => {
  const box = document.getElementById("broadcastContradictions");
  if (box) {
    box.innerHTML = `
      <div class="broadcastContradiction">
        <b>${escapeHtml(data.playerName)}</b>
        <span>${escapeHtml(data.earlierLocation)} → ${escapeHtml(data.currentLocation)}</span>
      </div>
    ` + box.innerHTML;
  }

  document.getElementById("focus").innerText = "Contradiction Detected";
});

socket.on("streamEvent", (event) => {
  showEventBanner(event);
  document.getElementById("focus").innerText = event.title || "Stream Event";
});

socket.on("playerVoteUpdate", (data) => {
  // Reserved for future split player/audience vote display.
});

socket.on("directorUpdate", (data) => {
  renderDirector(data.detectiveDirector || []);
  renderIntensity(data.caseIntensity);
});

socket.on("newMessage", (data) => {
  statements.unshift(data);
  statements = statements.slice(0, 6);
  renderStatements();
});

socket.on("reveal", (data) => {
  const steps = (data.resolutionSteps || []).slice(0, 4).map((step, index) => `
    <div class="broadcastRevealStep">
      <span>${index + 1}</span>
      <p>${escapeHtml(step)}</p>
    </div>
  `).join("");

  document.getElementById("result").innerHTML = `
    <div class="broadcastRevealCinematic">
      <h2>${data.success ? "✅ CASE SOLVED" : "❌ MURDERER ESCAPED"}</h2>
      <h3>Real Murderer: ${escapeHtml(data.culpritName)}</h3>
      ${steps}
    </div>
  `;

  document.getElementById("focus").innerText = data.success ? "Solved" : "Murderer Escaped";
});


function renderDirector(items) {
  const box = document.getElementById("broadcastDirector");
  if (!box) return;

  const rows = (items || []).slice(0, 3);
  if (!rows.length) {
    box.innerHTML = "<p>No guidance yet.</p>";
    return;
  }

  box.innerHTML = rows.map((item) => `
    <div class="broadcastDirectorItem ${escapeHtml(item.type || "info")}">
      <b>${escapeHtml(item.title || "Suggestion")}</b>
      <p>${escapeHtml(item.action || item.text || "Ask a follow-up question.")}</p>
    </div>
  `).join("");
}

function renderIntensity(intensity) {
  const label = document.getElementById("caseIntensityLabel");
  const box = document.getElementById("broadcastIntensity");
  if (!intensity) intensity = { score: 0, label: "Calm", reasons: [] };
  const score = Math.max(0, Math.min(100, Number(intensity.score || 0)));

  if (label) label.innerText = intensity.label || "Calm";
  if (!box) return;

  box.className = `broadcastIntensity broadcastIntensity${escapeHtml(intensity.label || "Calm")}`;
  box.innerHTML = `
    <div><b>Case Intensity</b><span>${escapeHtml(intensity.label || "Calm")} • ${score}%</span></div>
    <div class="broadcastIntensityMeter"><div style="width:${score}%"></div></div>
  `;
}

function renderSusBoard() {
  const board = document.getElementById("susBoard");
  const sorted = [...players].sort((a, b) => (b.suspicion || 0) - (a.suspicion || 0)).slice(0, 5);

  board.innerHTML = sorted.length
    ? sorted.map((p, index) => `
      <div class="broadcastSusRow ${index === 0 && p.suspicion > 0 ? "topSuspectGlow" : ""}">
        <span>${index + 1}. ${escapeHtml(p.name)}</span>
        <div class="broadcastMeter"><div style="width:${p.suspicion || 0}%"></div></div>
        <b>${p.suspicion || 0}%</b>
      </div>
    `).join("")
    : "<p>No suspects yet.</p>";
}

function renderVoteBoard(votes) {
  const board = document.getElementById("viewerVotes");
  if (!board) return;

  const activeVotes = (votes || []).filter((v) => v.votes > 0).slice(0, 5);

  board.innerHTML = activeVotes.length
    ? activeVotes.map((v, index) => `
      <div class="broadcastSusRow ${index === 0 ? "topSuspectGlow" : ""}">
        <span>${index + 1}. ${escapeHtml(v.name)}</span>
        <div class="broadcastMeter"><div style="width:${v.percent || 0}%"></div></div>
        <b>${v.percent || 0}%</b>
      </div>
    `).join("")
    : "<p>No viewer votes yet.</p>";
}

function renderStatements() {
  document.getElementById("liveStatements").innerHTML = statements.map(s => `
    <div class="broadcastStatement">
      <span>${escapeHtml(s.tag)}</span>
      <b>${escapeHtml(s.name)}:</b>
      ${escapeHtml(s.message)}
    </div>
  `).join("");
}

function showEventBanner(event) {
  const banner = document.getElementById("broadcastEventBanner");
  if (!banner || !event) return;

  banner.style.display = "block";
  banner.innerHTML = `
    <div class="eventIcon">${escapeHtml(event.icon || "🎬")}</div>
    <div>
      <b>${escapeHtml(event.title || "STREAM EVENT")}</b>
      <p>${escapeHtml(event.message || "")}</p>
    </div>
  `;

  clearTimeout(showEventBanner.timer);
  showEventBanner.timer = setTimeout(() => hideEventBanner(), 14000);
}

function hideEventBanner() {
  const banner = document.getElementById("broadcastEventBanner");
  if (!banner) return;
  banner.style.display = "none";
  banner.innerHTML = "";
}

function formatTime(seconds) {
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}