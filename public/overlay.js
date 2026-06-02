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
});

socket.on("roundStarted", (data) => {
  players = data.players || [];
  statements = [];

  document.getElementById("roundNumber").innerText = data.roundNumber;
  document.getElementById("timer").innerText = formatTime(data.timeLeft);
  document.getElementById("incident").innerText = data.incidentTitle;
  document.getElementById("accused").innerText = "None";
  document.getElementById("focus").innerText = "Investigating";
  document.getElementById("twist").innerText = "";
  document.getElementById("result").innerText = "";
  document.getElementById("liveStatements").innerHTML = "";

  renderSusBoard();
});

socket.on("suspicionUpdate", (data) => {
  players = data.players || [];
  renderSusBoard();
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

socket.on("newMessage", (data) => {
  statements.unshift(data);
  statements = statements.slice(0, 6);
  renderStatements();
});

socket.on("reveal", (data) => {
  document.getElementById("result").innerText = data.success
    ? `✅ CASE SOLVED — Culprit: ${data.culpritName}`
    : `❌ WRONG ACCUSATION — Culprit Escaped: ${data.culpritName}`;

  document.getElementById("focus").innerText = data.success ? "Solved" : "Culprit Escaped";
});

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

function renderStatements() {
  document.getElementById("liveStatements").innerHTML = statements.map(s => `
    <div class="broadcastStatement">
      <span>${escapeHtml(s.tag)}</span>
      <b>${escapeHtml(s.name)}:</b>
      ${escapeHtml(s.message)}
    </div>
  `).join("");
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