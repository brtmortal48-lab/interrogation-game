const socket = io();

let roomId = "";
let hostKey = "";
let players = [];
let minPlayers = 2;
let maxPlayers = 10;
let soundEnabled = true;
let roomLocked = true;

let musicEnabled = false;
let audioCtx = null;
let musicGain = null;
let musicNodes = [];
let musicInterval = null;

let theory = { trusted: [], interest: [], major: [], prime: [] };

window.onload = () => {
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get("room");
  const hostFromUrl = params.get("host");

  if (roomFromUrl) {
    document.getElementById("room").value = roomFromUrl.toUpperCase();
  }

  if (hostFromUrl) {
    hostKey = hostFromUrl;
  }

  const savedName = localStorage.getItem("interrogationStreamerName");
  if (savedName) {
    document.getElementById("streamerName").value = savedName;
  }

  restoreStreamerView();

  if (roomFromUrl) join();
};


function switchStreamerView(view) {
  document.querySelectorAll('.uxTabPanel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.view === view);
  });

  document.querySelectorAll('.uxTabBtn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  localStorage.setItem('interrogationStreamerView', view);
}

function restoreStreamerView() {
  const saved = localStorage.getItem('interrogationStreamerView') || 'overview';
  switchStreamerView(saved);
}

function join() {
  roomId = document.getElementById("room").value.trim().toUpperCase();
  const streamerName = document.getElementById("streamerName").value.trim() || "Detective";

  if (!roomId) return alert("Enter a room ID.");

  localStorage.setItem("interrogationStreamerName", streamerName);

  document.getElementById("roomLabel").innerText = roomId;
  document.getElementById("detectiveLabel").innerText = streamerName;
  document.getElementById("inviteLink").value = `${window.location.origin}/player.html?room=${roomId}`;
  document.getElementById("overlayLink").value = `${window.location.origin}/overlay.html?room=${roomId}`;
  document.getElementById("voteLink").value = `${window.location.origin}/vote.html?room=${roomId}`;

  socket.emit("joinRoom", {
    roomId,
    role: "streamer",
    name: streamerName,
    hostKey
  });
}

function openSettings() {
  document.getElementById("settingsModal").style.display = "flex";
}

function closeSettings() {
  document.getElementById("settingsModal").style.display = "none";
}

function toggleRoomLock() {
  roomLocked = !roomLocked;
  socket.emit("setRoomLock", { roomId, locked: roomLocked });
}

function copyInvite() { copyInput("inviteLink"); }
function copyOverlay() { copyInput("overlayLink"); }
function copyVote() { copyInput("voteLink"); }

function copyInput(id) {
  const el = document.getElementById(id);
  el.select();
  el.setSelectionRange(0, 99999);
  navigator.clipboard.writeText(el.value);
}

function saveSettings() {
  socket.emit("updateSettings", {
    roomId,
    settings: {
      minPlayers: document.getElementById("minPlayers").value,
      maxPlayers: document.getElementById("maxPlayers").value,
      roundTime: document.getElementById("roundTime").value,
      cooldown: document.getElementById("cooldown").value,
      difficulty: document.getElementById("difficulty").value
    }
  });

  closeSettings();
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  document.getElementById("soundState").innerText = soundEnabled ? "On" : "Off";
}

function toggleMusic() {
  if (musicEnabled) {
    stopMusic();
    musicEnabled = false;
    document.getElementById("musicState").innerText = "Off";
  } else {
    startSelectedMusic();
    musicEnabled = true;
    document.getElementById("musicState").innerText = "On";
  }
}

function restartMusicIfOn() {
  if (!musicEnabled) return;
  stopMusic();
  startSelectedMusic();
}

function startSelectedMusic() {
  const style = document.getElementById("musicStyle").value;

  if (style === "spaceSuspense") startSpaceSuspenseMusic();
  if (style === "cozyLobby") startCozyLobbyMusic();
  if (style === "warmMystery") startWarmMysteryMusic();
  if (style === "softNight") startSoftNightMusic();
  if (style === "differentTempo") startDifferentTempoMusic();
}

function createAudioBase(volumeDivisor = 950) {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();

  musicGain = audioCtx.createGain();
  musicGain.gain.value = Number(document.getElementById("musicVolume").value) / volumeDivisor;
  musicGain.connect(audioCtx.destination);

  return audioCtx;
}

function startSpaceSuspenseMusic() {
  const ctx = createAudioBase(950);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 720;

  const delay = ctx.createDelay();
  delay.delayTime.value = 0.38;

  const feedback = ctx.createGain();
  feedback.gain.value = 0.24;

  delay.connect(feedback);
  feedback.connect(delay);

  const bass = makeOsc(ctx, "sine", 55, 0.11, filter);
  const pad = makeOsc(ctx, "triangle", 110, 0.04, filter);

  filter.connect(delay);
  filter.connect(musicGain);
  delay.connect(musicGain);

  musicNodes.push(filter, delay, feedback, ...bass, ...pad);

  playLoopedMelody(ctx, [220, 196, 164.81, 146.83, 164.81, 196, 220, 130.81], filter, 760, 0.065, 0.78, "sine");
}

function startCozyLobbyMusic() {
  const ctx = createAudioBase(850);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1350;

  const pad1 = makeOsc(ctx, "sine", 196, 0.055, filter);
  const pad2 = makeOsc(ctx, "sine", 246.94, 0.045, filter);
  const pad3 = makeOsc(ctx, "sine", 329.63, 0.035, filter);

  filter.connect(musicGain);

  musicNodes.push(filter, ...pad1, ...pad2, ...pad3);

  playLoopedMelody(ctx, [392, 329.63, 293.66, 246.94, 293.66, 329.63], filter, 1200, 0.055, 0.85, "sine");
}

function startWarmMysteryMusic() {
  const ctx = createAudioBase(850);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1000;

  const bass = makeOsc(ctx, "sine", 65.41, 0.09, filter);
  const pad1 = makeOsc(ctx, "triangle", 130.81, 0.045, filter);
  const pad2 = makeOsc(ctx, "sine", 196, 0.035, filter);

  filter.connect(musicGain);

  musicNodes.push(filter, ...bass, ...pad1, ...pad2);

  playLoopedMelody(ctx, [261.63, 293.66, 329.63, 293.66, 246.94, 220], filter, 980, 0.06, 0.7, "sine");
}

function startSoftNightMusic() {
  const ctx = createAudioBase(800);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1500;

  const pad1 = makeOsc(ctx, "sine", 174.61, 0.045, filter);
  const pad2 = makeOsc(ctx, "sine", 220, 0.035, filter);
  const pad3 = makeOsc(ctx, "sine", 261.63, 0.03, filter);

  const delay = ctx.createDelay();
  delay.delayTime.value = 0.55;

  const feedback = ctx.createGain();
  feedback.gain.value = 0.18;

  delay.connect(feedback);
  feedback.connect(delay);

  filter.connect(delay);
  filter.connect(musicGain);
  delay.connect(musicGain);

  musicNodes.push(filter, delay, feedback, ...pad1, ...pad2, ...pad3);

  playLoopedMelody(ctx, [349.23, 293.66, 261.63, 220, 261.63, 293.66], filter, 1500, 0.045, 1.05, "sine");
}

function startDifferentTempoMusic() {
  const ctx = createAudioBase(850);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 900;

  const sub = makeOsc(ctx, "sine", 49, 0.12, filter);
  const pulse = makeOsc(ctx, "triangle", 98, 0.04, filter);

  filter.connect(musicGain);

  musicNodes.push(filter, ...sub, ...pulse);

  playLoopedMelody(ctx, [196, 246.94, 220, 164.81, 196, 146.83, 164.81, 220], filter, 430, 0.055, 0.28, "triangle");
}

function makeOsc(ctx, type, freq, volume, destination) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = volume;

  osc.connect(gain);
  gain.connect(destination);
  osc.start();

  return [osc, gain];
}

function playLoopedMelody(ctx, notes, destination, intervalMs, volume, lengthSeconds, type = "sine") {
  let step = 0;

  musicInterval = setInterval(() => {
    if (!musicEnabled) return;

    const note = ctx.createOscillator();
    const gain = ctx.createGain();

    note.type = type;
    note.frequency.value = notes[step % notes.length];

    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + lengthSeconds);

    note.connect(gain);
    gain.connect(destination);

    note.start();
    note.stop(ctx.currentTime + lengthSeconds + 0.05);

    step++;
  }, intervalMs);
}

function stopMusic() {
  if (musicInterval) {
    clearInterval(musicInterval);
    musicInterval = null;
  }

  musicNodes.forEach((node) => {
    try {
      if (node.stop) node.stop();
      if (node.disconnect) node.disconnect();
    } catch {}
  });

  musicNodes = [];

  try {
    if (musicGain) musicGain.disconnect();
  } catch {}

  musicGain = null;
}

function setMusicVolume(value) {
  if (musicGain) musicGain.gain.value = Number(value) / 850;
}

function startRound() {
  if (!roomId) return alert("Join a room first.");

  theory = { trusted: [], interest: [], major: [], prime: [] };

  document.getElementById("result").innerHTML = "";
  document.getElementById("accused").innerText = "None";
  document.getElementById("spotlight").innerText = "None";
  document.getElementById("chat").innerHTML = "";
  const contradictionsBox = document.getElementById("contradictions");
  if (contradictionsBox) contradictionsBox.innerHTML = `<p class="hint">Contradictions appear when player statements conflict with alibis or earlier locations.</p>`;

  renderTheoryBoard();
  socket.emit("startRound", roomId);
}

function triggerStreamEvent(type) {
  if (!roomId) return alert("Join a room first.");
  socket.emit("streamEvent", { roomId, type });
}

function interrogate(id) { socket.emit("interrogate", { roomId, playerId: id }); }
function accuse(id) { socket.emit("accuse", { roomId, playerId: id }); }
function suspicion(id, amount) { socket.emit("adjustSuspicion", { roomId, playerId: id, amount }); }
function pressure(id, type) { socket.emit("pressure", { roomId, playerId: id, type }); }
function reveal() { socket.emit("reveal", roomId); }

function kick(id) {
  if (confirm("Remove this player?")) socket.emit("kickPlayer", { roomId, playerId: id });
}

function moveToBoard(playerId, board) {
  theory.trusted = theory.trusted.filter((id) => id !== playerId);
  theory.interest = theory.interest.filter((id) => id !== playerId);
  theory.major = theory.major.filter((id) => id !== playerId);
  theory.prime = theory.prime.filter((id) => id !== playerId);

  theory[board].push(playerId);
  renderTheoryBoard();
}

function showMore(id) {
  const el = document.getElementById(`more-${id}`);
  el.style.display = el.style.display === "none" ? "block" : "none";
}

socket.on("joinError", (message) => {
  alert(message);
});

socket.on("roomUpdate", (data) => {
  players = data.players || [];
  minPlayers = data.minPlayers || 2;
  maxPlayers = data.maxPlayers || 10;

  if (data.streamerName) {
    document.getElementById("detectiveLabel").innerText = data.streamerName;
  }

  roomLocked = data.locked !== false;
  document.getElementById("lockState").innerText = roomLocked ? "Locked" : "Unlocked";

  if (data.settings) {
    document.getElementById("minPlayers").value = data.settings.minPlayers;
    document.getElementById("maxPlayers").value = data.settings.maxPlayers || 10;
    document.getElementById("roundTime").value = data.settings.roundTime;
    document.getElementById("cooldown").value = data.settings.cooldown;
    document.getElementById("difficulty").value = data.settings.difficulty;
  }

  renderPlayers(players);
  renderLobby(players);
  renderTheoryBoard();
  renderVoteBoard(data.viewerVotes || []);
  renderPlayerVoteBoard(data.playerVotes || []);

  document.getElementById("roundNumber").innerText = data.roundNumber || 0;
  document.getElementById("playerCount").innerText = `${players.length} / ${maxPlayers}`;
  document.getElementById("startBtn").disabled = players.length < minPlayers;
});

socket.on("roundStarted", (data) => {
  players = data.players || [];

  document.getElementById("incident").innerText = data.incidentTitle;
  document.getElementById("roundNumber").innerText = data.roundNumber;
  updateTimerDisplay(data.unlimitedTime ? 0 : data.timeLeft);

  renderCaseFile(data.caseFile);
  renderQuestions(data.suggestedQuestions || []);

  const evidenceDiv = document.getElementById("evidence");
  evidenceDiv.innerHTML = "";

  data.evidence.forEach((e) => appendEvidence(e));

  renderPlayers(players);
  renderTheoryBoard();
  renderVoteBoard(data.viewerVotes || []);
  renderPlayerVoteBoard(data.playerVotes || []);
  if (data.activeStreamEvent) renderStreamEvent(data.activeStreamEvent);
});

socket.on("midEvidenceDrop", (e) => {
  appendEvidence(e, true);
  addSystemMessage("🚨 NEW LEAD: Re-check the alibis.");
});

socket.on("suspicionUpdate", (data) => {
  players = data.players || [];
  renderPlayers(players);
  renderLobby(players);
  renderTheoryBoard();
});

socket.on("timerUpdate", (timeLeft) => {
  updateTimerDisplay(timeLeft);
});

socket.on("newMessage", (data) => {
  const chat = document.getElementById("chat");

  chat.innerHTML += `
    <div class="msg">
      <span class="time">${escapeHtml(data.time)}</span>
      <span class="tag">${escapeHtml(data.tag)}</span>
      <b>${escapeHtml(data.name)}:</b> ${escapeHtml(data.message)}
    </div>
  `;

  chat.scrollTop = chat.scrollHeight;
});

socket.on("systemMessage", (message) => addSystemMessage(message));

socket.on("spotlight", (data) => {
  document.getElementById("spotlight").innerText = `${data.playerName} (${data.seconds}s)`;
  addSystemMessage(`⏱ ${data.playerName} is now in the spotlight.`);
});

socket.on("spotlightEnd", () => {
  document.getElementById("spotlight").innerText = "None";
  addSystemMessage("Spotlight ended.");
});

socket.on("contradictionFound", (data) => {
  addContradiction(data);
  addSystemMessage(`🚨 Possible contradiction: ${data.playerName} mentioned ${data.currentLocation}, but earlier/alibi pointed to ${data.earlierLocation}.`);
});

socket.on("accusation", (data) => {
  document.getElementById("accused").innerText = data.playerName;
  moveToBoard(data.playerId, "prime");
  addSystemMessage(`Final suspicion is on ${data.playerName}.`);
});

socket.on("reveal", (data) => {
  const steps = (data.resolutionSteps || []).map((step, index) => `
    <div class="cinematicStep">
      <span>${index + 1}</span>
      <p>${escapeHtml(step)}</p>
    </div>
  `).join("");

  const contradictionSummary = (data.contradictions || []).length
    ? `<h3>Contradictions Found</h3>${data.contradictions.map(c => `
        <div class="contradictionItem">
          <b>${escapeHtml(c.playerName)}</b>
          <small>${escapeHtml(c.earlierLocation)} → ${escapeHtml(c.currentLocation)}</small>
          <p>${escapeHtml(c.reason || "Possible location conflict.")}</p>
        </div>
      `).join("")}`
    : `<h3>Contradictions Found</h3><p class="hint">No automatic contradictions were detected this round.</p>`;

  document.getElementById("result").innerHTML = `
    <div class="cinematicReveal ${data.success ? "solvedReveal" : "escapedReveal"}">
      <h2>${data.success ? "✅ CASE SOLVED" : "❌ MURDERER ESCAPED"}</h2>
      <p class="cinematicSubtitle">${escapeHtml(data.caseFile?.title || "Case Resolution")}</p>

      <div class="summaryGrid">
        <div class="summaryBox"><h3>Accused</h3><p>${escapeHtml(data.accusedPlayerName)}</p></div>
        <div class="summaryBox"><h3>Real Murderer</h3><p>${escapeHtml(data.culpritName)}</p></div>
        <div class="summaryBox"><h3>Location</h3><p>${escapeHtml(data.location)}</p></div>
      </div>

      <h3>How It Happened</h3>
      <div class="cinematicTimeline">${steps}</div>

      ${contradictionSummary}

      <h3>Round Summary</h3>
      ${data.players.map(p => `
        <div class="revealRow">
          <b>${escapeHtml(p.name)}</b> — ${escapeHtml(p.role)}
          <span class="score">+${p.gained} / ${p.score}</span>
          <br><small><b>Alibi:</b> ${escapeHtml(p.publicAlibi || "Unknown")}</small>
          <br><small><b>Observation:</b> ${escapeHtml(p.clue || "None")}</small>
          <br><small class="bonusObjectiveRow"><b>Bonus:</b> ${escapeHtml(p.bonusObjective || "None")} <span class="${p.bonusCompleted ? "bonusPassed" : "bonusFailed"}">${p.bonusCompleted ? "✓ Completed" : "✗ Failed"}</span></small>
        </div>
      `).join("")}
    </div>
  `;

  addSystemMessage("Truth revealed.");
});

socket.on("voteUpdate", (data) => {
  renderVoteBoard(data.viewerVotes || []);
});

socket.on("playerVoteUpdate", (data) => {
  renderPlayerVoteBoard(data.playerVotes || []);
});

socket.on("streamEvent", (event) => {
  renderStreamEvent(event);
  addSystemMessage(`${event.icon || "🎬"} ${event.title}: ${event.message}`);
});

socket.on("soundCue", playSound);

function updateTimerDisplay(timeLeft) {
  const timer = document.getElementById("timer");

  timer.classList.remove("timerWarning", "timerDanger");

  if (timeLeft === 0) {
    timer.innerText = "∞";
    return;
  }

  timer.innerText = formatTime(timeLeft);

  if (timeLeft <= 30) timer.classList.add("timerDanger");
  else if (timeLeft <= 60) timer.classList.add("timerWarning");
}

function renderVoteBoard(votes) {
  const div = document.getElementById("viewerVotes");
  if (!div) return;

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



function renderPlayerVoteBoard(votes) {
  const div = document.getElementById("playerVotes");
  if (!div) return;

  const activeVotes = (votes || []).filter((v) => v.votes > 0);

  if (!activeVotes.length) {
    div.innerHTML = `<p class="hint">No player emergency votes yet.</p>`;
    return;
  }

  div.innerHTML = activeVotes.map((v) => `
    <div class="voteRow">
      <div class="voteTop"><b>${escapeHtml(v.name)}</b><span>${v.votes} player vote${v.votes === 1 ? "" : "s"} • ${v.percent}%</span></div>
      <div class="voteMeter"><div style="width:${v.percent}%"></div></div>
    </div>
  `).join("");
}

function renderStreamEvent(event) {
  const box = document.getElementById("activeStreamEvent");
  if (!box || !event) return;

  box.className = "activeStreamEvent liveStreamEvent";
  box.innerHTML = `
    <b>${escapeHtml(event.icon || "🎬")} ${escapeHtml(event.title || "Stream Event")}</b>
    <p>${escapeHtml(event.message || "")}</p>
  `;
}

function addContradiction(data) {
  const box = document.getElementById("contradictions");
  if (!box) return;

  const current = box.innerHTML.includes("contradictionItem") ? box.innerHTML : "";
  box.innerHTML = `
    <div class="contradictionItem hotContradiction">
      <b>${escapeHtml(data.playerName)}</b>
      <small>${escapeHtml(data.earlierLocation)} → ${escapeHtml(data.currentLocation)}</small>
      <p>${escapeHtml(data.reason || "Possible location conflict detected.")}</p>
      <p><b>Earlier:</b> ${escapeHtml(data.earlier)}</p>
      <p><b>Now:</b> ${escapeHtml(data.current)}</p>
    </div>
  ` + current;
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
    <p><b>Known Facts:</b></p>
    <ul>
      ${(caseFile.knownFacts || []).map(fact => `<li>${escapeHtml(fact)}</li>`).join("")}
    </ul>
  `;
}

function renderQuestions(questions) {
  const div = document.getElementById("questions");
  if (!div) return;

  div.innerHTML = questions.length
    ? `<ul>${questions.map(q => `<li>${escapeHtml(q)}</li>`).join("")}</ul>`
    : `<p class="hint">No suggested questions yet.</p>`;
}

function appendEvidence(e, isNew = false) {
  document.getElementById("evidence").innerHTML += `
    <div class="card evidence ${e.reliability.toLowerCase()} ${isNew ? "newEvidence" : ""}">
      <b>${escapeHtml(e.type)}</b>
      <span class="badge">${escapeHtml(e.reliability)}</span>
      ${isNew ? "<div class='newBadge'>NEW LEAD</div>" : ""}
      <p>${escapeHtml(e.text)}</p>
    </div>
  `;
}

function renderPlayers(playerList) {
  const list = document.getElementById("players");
  list.innerHTML = "";

  if (!playerList.length) {
    list.innerHTML = "<p>No players yet.</p>";
    return;
  }

  playerList.forEach((p) => {
    list.innerHTML += `
      <div class="player compactPlayer">
        <div class="playerMain">
          <b>${escapeHtml(p.name)}</b>
          <small class="scoreSmall">Score: ${p.score || 0}</small>
          <p class="hint"><b>Alibi:</b> ${escapeHtml(p.publicAlibi || "No alibi yet.")}</p>
          <div class="meter"><div class="fill" style="width:${p.suspicion || 0}%"></div></div>
          <small>Suspicion: ${p.suspicion || 0}%</small>
        </div>

        <div class="playerBtns cleanBtns">
          <button onclick="interrogate('${p.id}')">Question</button>
          <button onclick="suspicion('${p.id}', 20)">+Sus</button>
          <button onclick="suspicion('${p.id}', -20)">-Sus</button>
          <button onclick="moveToBoard('${p.id}', 'trusted')">Trust</button>
          <button onclick="moveToBoard('${p.id}', 'interest')">Interest</button>
          <button onclick="moveToBoard('${p.id}', 'major')">Major</button>
          <button class="danger" onclick="accuse('${p.id}')">Accuse</button>
          <button onclick="showMore('${p.id}')">More</button>
        </div>

        <div id="more-${p.id}" class="moreControls" style="display:none;">
          <button onclick="pressure('${p.id}', 'yesno')">Yes/No Pressure</button>
          <button onclick="pressure('${p.id}', 'fact')">Force Fact</button>
          <button onclick="pressure('${p.id}', 'spotlight')">20s Spotlight</button>
          <button class="danger" onclick="kick('${p.id}')">Kick Player</button>
        </div>
      </div>
    `;
  });
}

function renderLobby(playerList) {
  document.getElementById("lobbyList").innerHTML = playerList.length
    ? playerList.map((p) => `<span class="lobbyPill">${escapeHtml(p.name)}</span>`).join("")
    : "No players yet.";
}

function renderTheoryBoard() {
  renderBoard("trustedBoard", theory.trusted);
  renderBoard("interestBoard", theory.interest);
  renderBoard("majorBoard", theory.major);
  renderBoard("primeBoard", theory.prime);
}

function renderBoard(elementId, ids) {
  const el = document.getElementById(elementId);
  if (!el) return;

  el.innerHTML = "";

  ids.forEach((id) => {
    const p = players.find((x) => x.id === id);
    if (p) {
      el.innerHTML += `
        <div class="theoryItem">
          ${escapeHtml(p.name)}
          <small>${p.suspicion || 0}% sus</small>
        </div>
      `;
    }
  });

  if (!el.innerHTML) el.innerHTML = `<small class="empty">None</small>`;
}

function addSystemMessage(message) {
  const chat = document.getElementById("chat");
  chat.innerHTML += `<div class="system">${escapeHtml(message)}</div>`;
  chat.scrollTop = chat.scrollHeight;
}

function playSound(type) {
  if (!soundEnabled) return;

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  const frequencies = {
    start: 523,
    twist: 392,
    pressure: 330,
    accuse: 220,
    success: 659,
    fail: 196
  };

  osc.frequency.value = frequencies[type] || 300;
  osc.type = "sine";
  gain.gain.value = 0.08;

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start();
  osc.stop(ctx.currentTime + 0.16);
}

function openHowTo() {
  document.getElementById("howToModal").style.display = "flex";
}

function closeHowTo() {
  document.getElementById("howToModal").style.display = "none";
}

function openContact() {
  document.getElementById("contactModal").style.display = "flex";
}

function closeContact() {
  document.getElementById("contactModal").style.display = "none";
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