const socket = io();

let roomId = "";
let name = "";
let players = [];
let currentRole = "";
let currentProfileCode = localStorage.getItem("interrogationProfileCode") || "";

window.onload = () => {
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get("room");

  if (roomFromUrl) {
    roomId = roomFromUrl.toUpperCase();
    document.getElementById("room").value = roomId;
    document.getElementById("roomLabel").innerText = roomId;
    document.getElementById("joinHint").innerText = `Joining room ${roomId}. Enter your name.`;
  }

  if (currentProfileCode) {
    document.getElementById("profileCode").value = currentProfileCode;
    socket.emit("loadProfile", { profileCode: currentProfileCode });
  }
};

function join() {
  name = document.getElementById("name").value.trim();
  roomId = document.getElementById("room").value.trim().toUpperCase();

  if (!name || !roomId) return alert("Enter your name and room ID.");

  document.getElementById("roomLabel").innerText = roomId;

  const profileCode = document.getElementById("profileCode").value.trim() || currentProfileCode;
  socket.emit("joinRoom", { roomId, role: "player", name, profileCode });

  document.getElementById("game").style.display = "block";
}


function createProfile() {
  const profileName = document.getElementById("name").value.trim();
  if (!profileName) return alert("Enter your display name first.");
  socket.emit("createProfile", { name: profileName });
}

function loadProfile() {
  const profileCode = document.getElementById("profileCode").value.trim();
  if (!profileCode) return alert("Enter your Profile ID.");
  socket.emit("loadProfile", { profileCode });
}

function copyProfileCode() {
  const code = currentProfileCode || document.getElementById("profileCode").value.trim();
  if (!code) return alert("No Profile ID yet. Create a profile first.");
  navigator.clipboard.writeText(code);
  addSystemMessage(`Profile ID copied: ${code}`);
}

function setProfileUI(profileCode, profile) {
  if (profileCode) {
    currentProfileCode = profileCode;
    localStorage.setItem("interrogationProfileCode", profileCode);
    document.getElementById("profileCode").value = profileCode;
    document.getElementById("profileCodeLabel").innerText = profileCode;
    document.getElementById("profileStatusBadge").innerText = "Profile linked";
    document.getElementById("profileStatusBadge").classList.add("profileLinked");
  }

  if (profile?.name && !document.getElementById("name").value.trim()) {
    document.getElementById("name").value = profile.name;
  }

  renderProfileStats(profile);
}

function send() {
  const input = document.getElementById("msg");
  const msg = input.value.trim();

  if (!msg) return;

  socket.emit("sendMessage", { roomId, message: msg });

  input.value = "";

  // If Force Alibis is active, any typed response counts as answering.
  clearStreamEventPrompt("forceAlibis");
}

function action(actionName, targetId = null) {
  socket.emit("playerAction", { roomId, action: actionName, targetId });

  if (actionName === "alibi") {
    clearStreamEventPrompt("forceAlibis");
  }
}

function useAbility() {
  if (currentRole === "Guard" || currentRole === "Lawyer") {
    chooseTarget("ability");
    return;
  }

  action("ability");
}

function useMurdererTool(type, needsTarget = false) {
  if (currentRole !== "Murderer") return alert("Only the murderer can use sabotage tools.");

  let targetId = null;
  if (needsTarget) {
    if (!players.length) return alert("No players yet.");
    const validTargets = players.filter((p) => p.name !== name);
    const names = validTargets.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
    const choice = prompt(`Choose sabotage target:\n${names}`);
    const index = Number(choice) - 1;
    if (!validTargets[index]) return;
    targetId = validTargets[index].id;
  }

  socket.emit("murdererTool", { roomId, type, targetId });
}

function renderMurdererTools(tools = []) {
  const box = document.getElementById("murdererToolsBox");
  const grid = document.getElementById("murdererToolsGrid");
  if (!box || !grid) return;

  if (currentRole !== "Murderer") {
    box.style.display = "none";
    grid.innerHTML = "";
    return;
  }

  box.style.display = "block";
  grid.innerHTML = tools.map((tool) => `
    <button class="sabotageToolBtn ${tool.used ? "used" : ""}" ${tool.used ? "disabled" : ""} onclick="useMurdererTool('${tool.type}', ${tool.needsTarget ? "true" : "false"})">
      <b>${escapeHtml(tool.icon)} ${escapeHtml(tool.label)}</b>
      <span>${escapeHtml(tool.used ? "Used" : tool.description)}</span>
    </button>
  `).join("");
}

function castEmergencyVote() {
  if (!players.length) return alert("No players yet.");

  const names = players.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  const choice = prompt(`Emergency Vote — choose the most suspicious player:\n${names}`);
  const index = Number(choice) - 1;

  if (!players[index]) return;

  socket.emit("playerVoteCast", { roomId, playerId: players[index].id });
  const btn = document.getElementById("playerVoteBtn");
  if (btn) btn.innerText = `Voted: ${players[index].name}`;
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
  document.getElementById("timer").innerText = data.unlimitedTime ? "∞" : formatTime(data.timeLeft);
  document.getElementById("status").innerText = "Playing";
  document.getElementById("chat").innerHTML = "";
  document.getElementById("token").innerText = "Reveal Token: Available";
  document.getElementById("revealBtn").disabled = false;

  const anonymousBtn = document.getElementById("anonymousBtn");
  if (anonymousBtn) {
    anonymousBtn.disabled = false;
    anonymousBtn.innerText = "Send Anonymous Tip";
  }

  const abilityBtn = document.getElementById("abilityBtn");
  if (abilityBtn) {
    abilityBtn.disabled = false;
    abilityBtn.innerText = "Use Special Ability";
  }

  document.getElementById("abilityStatus").innerText = "Ability: Available";
  renderMurdererTools([]);
  const streamBox = document.getElementById("streamEventBox");
  if (streamBox) {
    streamBox.style.display = "none";
    streamBox.innerHTML = "";
  }
  const voteBtn = document.getElementById("playerVoteBtn");
  if (voteBtn) {
    voteBtn.style.display = "none";
    voteBtn.disabled = false;
    voteBtn.innerText = "Cast Emergency Vote";
  }

  renderCaseFile(data.caseFile);

  hidePressure();
});

socket.on("privateData", (data) => {
  currentRole = data.role || "";

  document.getElementById("role").innerText = data.role || "Waiting...";
  document.getElementById("publicAlibi").innerText = data.publicAlibi || "Waiting for round...";
  document.getElementById("clue").innerText = data.clue || "Waiting for round...";
  document.getElementById("revealClue").innerText = data.revealClue || data.clue || "Waiting for round...";
  document.getElementById("confidence").innerText = data.observationQuality || data.confidence || "--";
  document.getElementById("objective").innerText = data.objective || "";
  document.getElementById("bonusObjective").innerText = data.bonusObjective || "No bonus objective this round.";
  setTextIfExists("relationshipIntel", data.relationship || "No relationship angle this round.");
  setTextIfExists("motiveIntel", data.motive || "No personal motive this round.");
  setTextIfExists("evidenceFragmentIntel", data.evidenceFragment || "No evidence fragment this round.");
  setTextIfExists("interrogationAngleIntel", data.interrogationAngle || "No interrogation angle this round.");
  document.getElementById("abilityName").innerText = data.abilityName || "Special Ability";
  document.getElementById("abilityDescription").innerText =
    data.abilityDescription || "Your role ability will appear when the round starts.";

  setProfileUI(data.profileCode, data.profileStats);

  const hiddenTruthBox = document.getElementById("hiddenTruthBox");
  const hiddenTruth = document.getElementById("hiddenTruth");

  if (data.hiddenTruth) {
    hiddenTruthBox.style.display = "block";
    hiddenTruth.innerText = data.hiddenTruth;
  } else {
    hiddenTruthBox.style.display = "none";
    hiddenTruth.innerText = "";
  }

  renderCaseFile(data.caseFile);
  renderMurdererTools(data.murdererTools || []);
});


socket.on("profileCreated", (data) => {
  setProfileUI(data.profileCode, data.profile);
  document.getElementById("joinHint").innerText = `Profile created. Save this ID: ${data.profileCode}`;
  alert(`Profile created! Save this ID so you never lose points: ${data.profileCode}`);
});

socket.on("profileLoaded", (data) => {
  setProfileUI(data.profileCode, data.profile);
  document.getElementById("joinHint").innerText = `Loaded profile ${data.profileCode}.`;
});

socket.on("profileLinked", (data) => {
  setProfileUI(data.profileCode, data.profile);
});

socket.on("profileError", (message) => {
  alert(message);
});

socket.on("anonymousUsed", () => {
  const anonymousBtn = document.getElementById("anonymousBtn");

  if (anonymousBtn) {
    anonymousBtn.disabled = true;
    anonymousBtn.innerText = "Anonymous Tip Used";
  }

  addSystemMessage("Your anonymous tip was sent.");
});

socket.on("abilityUsed", () => {
  const abilityBtn = document.getElementById("abilityBtn");

  if (abilityBtn) {
    abilityBtn.disabled = true;
    abilityBtn.innerText = "Ability Used";
  }

  document.getElementById("abilityStatus").innerText = "Ability: Used";
  addSystemMessage("Your special ability was used.");
});

socket.on("murdererToolUsed", (data) => {
  renderMurdererTools(data.tools || []);
  addSystemMessage("Sabotage tool used. Stay calm and keep your cover.");
});

socket.on("revealTokenUsed", () => {
  document.getElementById("token").innerText = "Reveal Token: Used";
  document.getElementById("revealBtn").disabled = true;
});

socket.on("timerUpdate", (timeLeft) => {
  document.getElementById("timer").innerText = timeLeft === 0 ? "∞" : formatTime(timeLeft);
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

socket.on("streamEventCleared", (event) => {
  clearStreamEventPrompt(event?.type);
});

socket.on("streamEvent", (event) => {
  const box = document.getElementById("streamEventBox");
  if (box) {
    box.style.display = "block";
    box.dataset.eventType = event.type || "";
    box.classList.toggle("urgent", event.type === "forceAlibis" || event.type === "emergencyVote");
    box.innerHTML = `
      <b>${escapeHtml(event.icon || "🎬")} ${escapeHtml(event.title || "Stream Event")}</b>
      <p>${escapeHtml(event.message || "")}</p>
      ${event.type === "forceAlibis" ? `<button onclick="action('alibi')">State My Alibi Now</button>` : ""}
    `;
  }

  const voteBtn = document.getElementById("playerVoteBtn");
  if (voteBtn && event.type === "emergencyVote") {
    voteBtn.style.display = "inline-block";
    voteBtn.disabled = false;
    voteBtn.innerText = "Cast Emergency Vote";
  }

  addSystemMessage(`${event.icon || "🎬"} ${event.title}: ${event.message}`);
});

socket.on("roundState", (data) => {
  document.getElementById("status").innerText = data.state;
  document.getElementById("roundNumber").innerText = data.roundNumber;
});

socket.on("interrogated", () => {
  document.getElementById("status").innerText = "You are being interrogated!";
  addSystemMessage("The streamer is questioning you. Defend your alibi carefully.");
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
    `Reveal: ${data.success ? "Detective was correct." : "Murderer escaped."} Murderer: ${data.culpritName}.`
  );

  document.getElementById("status").innerText = "Round ended";

  hidePressure();
});

socket.on("joinError", (message) => {
  alert(message);
});

socket.on("kicked", (message) => {
  alert(message);
  location.href = "/";
});

document.addEventListener("DOMContentLoaded", () => {
  const msgInput = document.getElementById("msg");

  if (msgInput) {
    msgInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        send();
      }
    });
  }
});


function renderProfileStats(stats) {
  if (!stats) return;
  const title = document.getElementById("profileTitle");
  const points = document.getElementById("profilePoints");
  const games = document.getElementById("profileGames");
  const winRate = document.getElementById("profileWinRate");

  const code = document.getElementById("profileCodeLabel");
  if (code && (stats.profileCode || stats.id)) code.innerText = stats.profileCode || stats.id;
  if (title) title.innerText = stats.title || "Rookie";
  if (points) points.innerText = stats.points || 0;
  if (games) games.innerText = stats.games || 0;
  if (winRate) winRate.innerText = `${stats.winRate || 0}%`;
  const displayName = document.getElementById("profileDisplayName");
  const rankMini = document.getElementById("profileRankMini");
  const statusMini = document.getElementById("profileStatusMini");
  if (displayName) displayName.innerText = stats.name || "Guest Player";
  if (rankMini) rankMini.innerText = stats.title || "Rookie";
  if (statusMini) statusMini.innerText = (stats.profileCode || stats.id || "").startsWith("LOCAL-") ? "Guest" : "Linked";
}

function renderCaseFile(caseFile) {
  const box = document.getElementById("caseFile");
  if (!box || !caseFile) return;

  box.innerHTML = `
    <h3>${escapeHtml(caseFile.title)}</h3>
    <p><b>Location:</b> ${escapeHtml(caseFile.location)}</p>
    <p><b>Time:</b> ${escapeHtml(caseFile.time)}</p>
    <p><b>Incident:</b> ${escapeHtml(caseFile.incident)}</p>
    <p>${escapeHtml(caseFile.atmosphere)}</p>
    <div class="caseDepthMini">
      <p><b>Motive Theme:</b> ${escapeHtml(caseFile.motiveTheme || "Unknown")}</p>
      <p><b>Suspicious Object:</b> ${escapeHtml(caseFile.suspiciousObject || "Unknown")}</p>
      <p><b>Conflict:</b> ${escapeHtml(caseFile.conflictingDetail || "No conflict yet.")}</p>
    </div>
    <p><b>Known Facts:</b></p>
    <ul>
      ${(caseFile.knownFacts || []).map(fact => `<li>${escapeHtml(fact)}</li>`).join("")}
    </ul>
  `;
}

function clearStreamEventPrompt(type = null) {
  const box = document.getElementById("streamEventBox");
  if (!box) return;

  const activeType = box.dataset.eventType || "";

  // Force Alibis should clear immediately after the player states alibi or sends a response.
  // This prevents the red blinking prompt from staying on screen.
  if (type && activeType && activeType !== type && type !== "forceAlibis") return;

  box.style.display = "none";
  box.innerHTML = "";
  box.dataset.eventType = "";
  box.classList.remove("active", "urgent", "blink", "forceAlibisActive");

  if (type === "forceAlibis") {
    hidePressure();
    addSystemMessage("Alibi response received. Event prompt cleared.");
  }
}

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

function setTextIfExists(id, value) {
  const el = document.getElementById(id);
  if (el) el.innerText = value;
}

function openFeedback() {
  const modal = document.getElementById("feedbackModal");
  if (modal) modal.style.display = "flex";
}

function closeFeedback() {
  const modal = document.getElementById("feedbackModal");
  if (modal) modal.style.display = "none";
}

function submitFeedback() {
  const type = document.getElementById("feedbackType")?.value || "General";
  const message = document.getElementById("feedbackMessage")?.value.trim() || "";
  if (!message) return alert("Write your feedback first.");
  socket.emit("submitFeedback", { type, message, name: name || document.getElementById("name")?.value || "Player", roomId, profileCode: currentProfileCode });
}

socket.on("feedbackThanks", (data) => {
  alert(data.message || "Thanks for the feedback!");
  const msg = document.getElementById("feedbackMessage");
  if (msg) msg.value = "";
  closeFeedback();
});

socket.on("feedbackError", (message) => alert(message));

function openHowTo() {
  document.getElementById("howToModal").style.display = "flex";
}

function closeHowTo() {
  document.getElementById("howToModal").style.display = "none";
}