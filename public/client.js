const socket = io();

let roomId = "";
let name = "";
let players = [];

window.onload = () => {
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get("room");

  if (roomFromUrl) {
    roomId = roomFromUrl.toUpperCase();
    document.getElementById("room").value = roomId;
    document.getElementById("roomLabel").innerText = roomId;
    document.getElementById("joinHint").innerText = `Joining room ${roomId}. Enter your name.`;
  }
};

function join() {
  name = document.getElementById("name").value.trim();
  roomId = document.getElementById("room").value.trim().toUpperCase();

  if (!name || !roomId) return alert("Enter your name and room ID.");

  document.getElementById("roomLabel").innerText = roomId;

  socket.emit("joinRoom", { roomId, role: "player", name });

  document.getElementById("game").style.display = "block";
}

function send() {
  const input = document.getElementById("msg");
  const msg = input.value.trim();

  if (!msg) return;

  socket.emit("sendMessage", { roomId, message: msg });

  input.value = "";
}

function action(actionName, targetId = null) {
  socket.emit("playerAction", { roomId, action: actionName, targetId });
}

function chooseTarget(actionName) {
  if (!players.length) return alert("No players yet.");

  const names = players.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  const choice = prompt(`Choose target:\n${names}`);
  const index = Number(choice) - 1;

  if (!players[index]) return;

  action(actionName, players[index].id);
}

socket.on("roomUpdate", (data) => {
  players = data.players || [];
  document.getElementById("roundNumber").innerText = data.roundNumber || 0;
});

socket.on("roundStarted", (data) => {
  players = data.players || [];

  document.getElementById("roundNumber").innerText = data.roundNumber;
  document.getElementById("timer").innerText = formatTime(data.timeLeft);
  document.getElementById("status").innerText = "Playing";
  document.getElementById("chat").innerHTML = "";
  document.getElementById("token").innerText = "Reveal Token: Available";
  document.getElementById("revealBtn").disabled = false;

  hidePressure();
});

socket.on("privateData", (data) => {
  document.getElementById("role").innerText = data.role;
  document.getElementById("clue").innerText = data.clue;
  document.getElementById("confidence").innerText = data.confidence;
  document.getElementById("objective").innerText = data.objective;
});

socket.on("revealTokenUsed", () => {
  document.getElementById("token").innerText = "Reveal Token: Used";
  document.getElementById("revealBtn").disabled = true;
});

socket.on("timerUpdate", (timeLeft) => {
  document.getElementById("timer").innerText = formatTime(timeLeft);
});

socket.on("newMessage", (data) => {
  const div = document.getElementById("chat");

  div.innerHTML += `
    <div class="msg">
      <span class="time">${escapeHtml(data.time)}</span>
      <span class="tag">${escapeHtml(data.tag)}</span>
      <b>${escapeHtml(data.name)}:</b>
      ${escapeHtml(data.message)}
    </div>
  `;

  div.scrollTop = div.scrollHeight;
});

socket.on("systemMessage", (message) => addSystemMessage(message));

socket.on("roundState", (data) => {
  document.getElementById("status").innerText = data.state;
  document.getElementById("roundNumber").innerText = data.roundNumber;
});

socket.on("interrogated", () => {
  document.getElementById("status").innerText = "You are being interrogated!";
  addSystemMessage("The streamer is questioning you. Be careful.");
});

socket.on("pressure", (data) => {
  const box = document.getElementById("pressureBox");

  box.style.display = "block";
  box.innerText = `⚠ PRESSURE: ${data.message}`;

  document.getElementById("status").innerText = "Under Pressure";

  addSystemMessage(data.message);
});

socket.on("pressureCleared", () => {
  hidePressure();
});

socket.on("accusation", (data) => {
  addSystemMessage(`${data.playerName} has been accused.`);
});

socket.on("reveal", (data) => {
  addSystemMessage(
    `Reveal: ${data.success ? "Streamer was correct." : "Culprit escaped."} Culprit: ${data.culpritName}.`
  );

  document.getElementById("status").innerText = "Round ended";

  hidePressure();
});

function hidePressure() {
  const box = document.getElementById("pressureBox");

  box.style.display = "none";
  box.innerText = "";
}

function addSystemMessage(message) {
  const div = document.getElementById("chat");

  div.innerHTML += `<div class="system">${escapeHtml(message)}</div>`;

  div.scrollTop = div.scrollHeight;
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

function openHowTo() {
  document.getElementById("howToModal").style.display = "flex";
}

function closeHowTo() {
  document.getElementById("howToModal").style.display = "none";
}

socket.on("joinError", (message) => {
  alert(message);
});

socket.on("kicked", (message) => {
  alert(message);
  location.href = "/";
});