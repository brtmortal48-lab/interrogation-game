const socket = io();

let roomId = "";
let players = [];
let selectedPlayerId = localStorage.getItem("viewerVoteSelected") || "";
let voterId = localStorage.getItem("interrogationViewerId");

if (!voterId) {
  voterId = `viewer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  localStorage.setItem("interrogationViewerId", voterId);
}

window.onload = () => {
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get("room");

  if (roomFromUrl) {
    roomId = roomFromUrl.toUpperCase();
    document.getElementById("room").value = roomId;
    joinVoteRoom();
  }
};

function joinVoteRoom() {
  roomId = document.getElementById("room").value.trim().toUpperCase();
  if (!roomId) return alert("Enter a room ID.");

  socket.emit("joinRoom", { roomId, role: "voter" });
}

function castVote(playerId) {
  selectedPlayerId = playerId;
  localStorage.setItem("viewerVoteSelected", selectedPlayerId);

  socket.emit("voteCast", {
    roomId,
    voterId,
    playerId
  });

  renderPlayers();
}

socket.on("roomUpdate", (data) => {
  players = data.players || [];
  renderPlayers();
  renderVoteResults(data.viewerVotes || []);
});

socket.on("roundStarted", (data) => {
  players = data.players || [];
  selectedPlayerId = "";
  localStorage.removeItem("viewerVoteSelected");
  renderPlayers();
  renderVoteResults(data.viewerVotes || []);
});

socket.on("voteUpdate", (data) => {
  players = data.players || players;
  renderPlayers();
  renderVoteResults(data.viewerVotes || []);
});

socket.on("reveal", () => {
  selectedPlayerId = "";
  localStorage.removeItem("viewerVoteSelected");
});

function renderPlayers() {
  const div = document.getElementById("votePlayers");

  if (!players.length) {
    div.innerHTML = `<p class="hint">No players in this room yet.</p>`;
    return;
  }

  div.innerHTML = players.map((p) => `
    <button class="voteChoice ${selectedPlayerId === p.id ? "selectedVote" : ""}" onclick="castVote('${p.id}')">
      <b>${escapeHtml(p.name)}</b>
      <small>${selectedPlayerId === p.id ? "Your vote" : "Vote suspect"}</small>
    </button>
  `).join("");
}

function renderVoteResults(votes) {
  const div = document.getElementById("voteResults");
  const activeVotes = (votes || []).filter((v) => v.votes > 0);

  if (!activeVotes.length) {
    div.innerHTML = `<p class="hint">No viewer votes yet.</p>`;
    return;
  }

  div.innerHTML = activeVotes.map((v) => `
    <div class="voteRow">
      <div class="voteTop"><b>${escapeHtml(v.name)}</b><span>${v.votes} vote${v.votes === 1 ? "" : "s"} • ${v.percent}%</span></div>
      <div class="voteMeter"><div style="width:${v.percent}%"></div></div>
    </div>
  `).join("");
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
