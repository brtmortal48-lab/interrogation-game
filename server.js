const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server);

const rooms = {};
const DEFAULT_SETTINGS = {
  minPlayers: 2,
  roundTime: 210,
  cooldown: 4000,
  difficulty: "normal"
};

io.on("connection", (socket) => {
  socket.on("createRoom", () => {
    let roomId = generateRoomCode();
    while (rooms[roomId]) roomId = generateRoomCode();

    const hostKey = generateHostKey();
    rooms[roomId] = createRoom(hostKey);

    socket.emit("roomCreated", { roomId, hostKey });
  });

  socket.on("joinRoom", ({ roomId, role, name, hostKey }) => {
    if (!roomId) return;

    roomId = String(roomId).trim().toUpperCase();
    socket.join(roomId);

    if (!rooms[roomId]) rooms[roomId] = createRoom(generateHostKey());
    const room = rooms[roomId];

    if (role === "streamer") {
      if (room.locked && hostKey !== room.hostKey) {
        socket.emit("joinError", "This room is locked. Use the private streamer host link.");
        return;
      }

      room.streamer = socket.id;
      room.streamerName = sanitizeName(name || "Streamer");
      emitRoomUpdate(roomId);
      return;
    }

    if (role === "overlay") {
      emitRoomUpdate(roomId);
      return;
    }

    if (role !== "player") return;

    const cleanName = sanitizeName(name);

    const duplicate = room.players.find(
      (p) => p.name.toLowerCase() === cleanName.toLowerCase() && p.id !== socket.id
    );

    if (duplicate) {
      socket.emit("joinError", "That name is already taken in this room.");
      return;
    }

    if (!room.players.find((p) => p.id === socket.id)) {
      room.players.push({
        id: socket.id,
        name: cleanName,
        lastMessageAt: 0,
        role: null,
        clue: null,
        fakeRevealClue: null,
        confidence: null,
        objective: null,
        suspicion: 0,
        revealedClue: false,
        anonymousUsed: false,
        score: 0,
        pressure: null
      });
    }

    emitRoomUpdate(roomId);
  });

  socket.on("setRoomLock", ({ roomId, locked }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.streamer) return;

    room.locked = Boolean(locked);
    io.to(roomId).emit("systemMessage", room.locked ? "Room is locked." : "Room is unlocked.");
    emitRoomUpdate(roomId);
  });

  socket.on("updateSettings", ({ roomId, settings }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.streamer) return;

    room.settings = {
      minPlayers: clamp(Number(settings.minPlayers), 2, 30),
      roundTime: clamp(Number(settings.roundTime), 60, 600),
      cooldown: clamp(Number(settings.cooldown), 1000, 15000),
      difficulty: ["easy", "normal", "hard"].includes(settings.difficulty)
        ? settings.difficulty
        : "normal"
    };

    emitRoomUpdate(roomId);
    io.to(roomId).emit("systemMessage", "Room settings updated.");
  });

  socket.on("kickPlayer", ({ roomId, playerId }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.streamer) return;

    const player = room.players.find((p) => p.id === playerId);
    if (!player) return;

    io.to(playerId).emit("kicked", "You were removed from the room.");
    io.sockets.sockets.get(playerId)?.leave(roomId);

    room.players = room.players.filter((p) => p.id !== playerId);

    io.to(roomId).emit("systemMessage", `${player.name} was removed from the room.`);
    emitRoomUpdate(roomId);
  });

  socket.on("sendMessage", ({ roomId, message }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    const now = Date.now();

    if (now - player.lastMessageAt < room.settings.cooldown) {
      socket.emit(
        "systemMessage",
        `Wait ${Math.ceil((room.settings.cooldown - (now - player.lastMessageAt)) / 1000)}s.`
      );
      return;
    }

    const clean = sanitizeMessage(message);
    if (!clean) return;

    player.lastMessageAt = now;

    if (player.pressure === "yesno") {
      const upper = clean.toUpperCase();

      if (upper !== "YES" && upper !== "NO") {
        socket.emit("systemMessage", "Pressure active: answer only YES or NO.");
        return;
      }

      player.pressure = null;
      io.to(player.id).emit("pressureCleared");
    }

    if (player.pressure === "fact") {
      player.pressure = null;
      io.to(player.id).emit("pressureCleared");
    }

    emitChat(roomId, player, clean, "Statement");
  });

  socket.on("playerAction", ({ roomId, action, targetId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    const target = room.players.find((p) => p.id === targetId);
    const targetName = target ? target.name : "someone";

    let text = "";

    if (action === "claim") text = "I have information, but I need you to ask the right question.";
    if (action === "defend") text = "I think I am being framed or misunderstood.";
    if (action === "doubt") text = `I doubt ${targetName}'s story.`;
    if (action === "accuse") text = `I think ${targetName} is hiding something.`;

    if (action === "anonymous") {
      if (player.role !== "Culprit") {
        socket.emit("systemMessage", "Only the culprit can use Anonymous Tip.");
        return;
      }

      if (player.anonymousUsed) {
        socket.emit("systemMessage", "You already used your Anonymous Tip this round.");
        return;
      }

      player.anonymousUsed = true;

      const anonymousText = generateAnonymousTip(room, player);

      io.to(roomId).emit("newMessage", {
        playerId: "anonymous",
        name: "Anonymous Tip",
        message: anonymousText,
        tag: "ANONYMOUS",
        time: new Date().toLocaleTimeString()
      });

      io.to(player.id).emit("anonymousUsed");
      io.to(roomId).emit("systemMessage", "A suspicious anonymous tip has appeared.");
      return;
    }

    if (action === "reveal") {
      if (player.revealedClue) {
        socket.emit("systemMessage", "You already used your reveal token.");
        return;
      }

      player.revealedClue = true;

      const revealClue = player.role === "Culprit" && player.fakeRevealClue
        ? player.fakeRevealClue
        : player.clue;

      text = `I reveal my clue: "${revealClue}" Confidence: ${player.confidence}.`;

      io.to(player.id).emit("revealTokenUsed");
    }

    if (!text) return;

    emitChat(roomId, player, text, action.toUpperCase());
  });

  socket.on("startRound", (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    if (room.players.length < room.settings.minPlayers) {
      io.to(room.streamer).emit("systemMessage", `Need at least ${room.settings.minPlayers} players to start.`);
      return;
    }

    clearRoomTimer(room);

    room.state = "playing";
    room.roundNumber += 1;
    room.timeLeft = room.settings.roundTime;
    room.accused = null;
    room.midEvidenceDropped = false;
    room.spotlightPlayerId = null;
    room.incident = generateIncident(room.players, room.settings.difficulty);

    assignRolesAndClues(room);

    room.evidence = generateEvidence(room);
    room.midEvidence = generateMidEvidence(room);

    room.players.forEach((p) => {
      p.suspicion = 0;
      p.revealedClue = false;
      p.anonymousUsed = false;
      p.pressure = null;

      io.to(p.id).emit("privateData", {
        role: p.role,
        clue: p.clue,
        revealClue: p.role === "Culprit" && p.fakeRevealClue ? p.fakeRevealClue : p.clue,
        confidence: p.confidence,
        objective: p.objective,
        canUseAnonymous: p.role === "Culprit"
      });

      io.to(p.id).emit("roundState", {
        state: "playing",
        roundNumber: room.roundNumber
      });
    });

    io.to(roomId).emit("roundStarted", {
      evidence: room.evidence,
      players: publicPlayers(room.players),
      roundNumber: room.roundNumber,
      timeLeft: room.timeLeft,
      incidentTitle: room.incident.title,
      streamerName: room.streamerName
    });

    io.to(roomId).emit("soundCue", "start");
    emitRoomUpdate(roomId);

    room.timer = setInterval(() => {
      room.timeLeft -= 1;
      io.to(roomId).emit("timerUpdate", room.timeLeft);

      if (!room.midEvidenceDropped && room.timeLeft === Math.floor(room.settings.roundTime / 2)) {
        room.midEvidenceDropped = true;

        io.to(roomId).emit("midEvidenceDrop", room.midEvidence);
        io.to(roomId).emit("systemMessage", "🚨 New evidence recovered. Re-check your theory.");
        io.to(roomId).emit("soundCue", "twist");
      }

      if (room.timeLeft <= 0) {
        clearRoomTimer(room);
        room.state = "accusation";

        io.to(roomId).emit("systemMessage", "Time is up. Make your final accusation.");
        io.to(roomId).emit("soundCue", "pressure");

        emitRoomUpdate(roomId);
      }
    }, 1000);
  });

  socket.on("interrogate", ({ roomId, playerId }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.streamer) return;

    const player = room.players.find((p) => p.id === playerId);
    if (!player) return;

    io.to(playerId).emit("interrogated");
    io.to(roomId).emit("systemMessage", `${player.name} is under pressure.`);
    io.to(roomId).emit("soundCue", "pressure");
  });

  socket.on("pressure", ({ roomId, playerId, type }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.streamer) return;

    const player = room.players.find((p) => p.id === playerId);
    if (!player) return;

    if (type === "yesno") {
      player.pressure = "yesno";

      io.to(player.id).emit("pressure", {
        type: "yesno",
        message: "Answer your next message with only YES or NO."
      });

      io.to(roomId).emit("systemMessage", `${player.name} must answer YES or NO.`);
    }

    if (type === "fact") {
      player.pressure = "fact";

      io.to(player.id).emit("pressure", {
        type: "fact",
        message: "Reveal one useful statement. Do not dodge."
      });

      io.to(roomId).emit("systemMessage", `${player.name} must reveal one useful statement.`);
    }

    if (type === "spotlight") {
      room.spotlightPlayerId = player.id;

      io.to(player.id).emit("pressure", {
        type: "spotlight",
        message: "You are in the 20-second spotlight. Defend yourself now."
      });

      io.to(roomId).emit("spotlight", {
        playerId: player.id,
        playerName: player.name,
        seconds: 20
      });

      io.to(roomId).emit("systemMessage", `${player.name} is in the spotlight for 20 seconds.`);

      setTimeout(() => {
        if (rooms[roomId]) {
          rooms[roomId].spotlightPlayerId = null;
          io.to(roomId).emit("spotlightEnd");
          io.to(player.id).emit("pressureCleared");
        }
      }, 20000);
    }

    io.to(roomId).emit("soundCue", "pressure");
  });

  socket.on("adjustSuspicion", ({ roomId, playerId, amount }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.streamer) return;

    const player = room.players.find((p) => p.id === playerId);
    if (!player) return;

    player.suspicion = Math.max(0, Math.min(100, player.suspicion + amount));

    io.to(roomId).emit("suspicionUpdate", {
      players: publicPlayers(room.players)
    });
  });

  socket.on("accuse", ({ roomId, playerId }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.streamer) return;

    const player = room.players.find((p) => p.id === playerId);
    if (!player) return;

    room.accused = playerId;

    io.to(roomId).emit("accusation", {
      playerId,
      playerName: player.name
    });

    io.to(roomId).emit("soundCue", "accuse");
  });

  socket.on("reveal", (roomId) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.streamer || !room.incident) return;

    clearRoomTimer(room);
    room.state = "revealed";

    const culprit = room.players.find((p) => p.id === room.incident.culpritId);
    const accused = room.players.find((p) => p.id === room.accused);
    const success = room.accused === room.incident.culpritId;

    room.players.forEach((p) => {
      let gained = 0;

      if (p.role === "Culprit") gained = success ? 0 : 100;
      else if (p.role === "Witness") gained = success ? 100 : 25;
      else if (p.role === "Misinformed") gained = room.accused !== p.id ? 50 : 0;
      else if (p.role === "Observer") gained = room.accused !== p.id ? 25 : 0;

      p.score += gained;
      p.lastGained = gained;
    });

    const helpers = room.players.filter((p) => p.role === "Witness");
    const misleaders = room.players.filter((p) => p.role === "Misinformed");
    const escaped = !success && culprit ? culprit.name : null;

    io.to(roomId).emit("reveal", {
      success,
      accusedPlayerName: accused ? accused.name : "No accusation",
      culpritName: culprit ? culprit.name : "Unknown",
      cause: room.incident.cause,
      location: room.incident.location,
      helpers: helpers.map((p) => p.name),
      misleaders: misleaders.map((p) => p.name),
      escaped,
      players: room.players.map((p) => ({
        name: p.name,
        role: p.role,
        clue: p.clue,
        fakeRevealClue: p.fakeRevealClue,
        confidence: p.confidence,
        suspicion: p.suspicion,
        score: p.score,
        gained: p.lastGained || 0
      }))
    });

    io.to(roomId).emit("soundCue", success ? "success" : "fail");
    emitRoomUpdate(roomId);
  });

  socket.on("disconnect", () => {
    for (const roomId of Object.keys(rooms)) {
      const room = rooms[roomId];

      room.players = room.players.filter((p) => p.id !== socket.id);

      if (room.streamer === socket.id) {
        room.streamer = null;
      }

      emitRoomUpdate(roomId);
    }
  });
});

function createRoom(hostKey) {
  return {
    players: [],
    streamer: null,
    streamerName: "Streamer",
    hostKey,
    locked: true,
    state: "lobby",
    roundNumber: 0,
    timeLeft: DEFAULT_SETTINGS.roundTime,
    timer: null,
    evidence: [],
    midEvidence: null,
    midEvidenceDropped: false,
    incident: null,
    accused: null,
    spotlightPlayerId: null,
    settings: { ...DEFAULT_SETTINGS }
  };
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function generateHostKey() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function generateIncident(players, difficulty) {
  const culprit = random(players);

  const hardTitles = [
    "Two records contradict each other after a blackout.",
    "A false security trail appeared minutes before failure.",
    "Someone manipulated access logs during a system crash."
  ];

  const normalTitles = [
    "A critical system failed under suspicious conditions.",
    "A restricted file was opened minutes before lockdown.",
    "The power grid collapsed after unusual movement nearby.",
    "A security alarm was triggered with incomplete footage.",
    "A valuable item vanished during a short blackout."
  ];

  return {
    culpritId: culprit.id,
    title: random(difficulty === "hard" ? hardTitles : normalTitles),
    cause: random(["tampering", "cover-up", "reckless mistake", "planned sabotage"]),
    location: random(["Control Room", "Generator Room", "Storage", "Security Office", "Sector A"])
  };
}

function assignRolesAndClues(room) {
  const culprit = room.players.find((p) => p.id === room.incident.culpritId);
  const others = room.players.filter((p) => p.id !== culprit.id).sort(() => Math.random() - 0.5);

  room.players.forEach((p) => {
    p.role = "Observer";
    p.confidence = random(["Low", "Medium"]);
    p.clue = random([
      `You heard movement near ${room.incident.location}, but did not see who it was.`,
      `You noticed people acting nervous after the incident.`,
      `You remember a noise near ${room.incident.location}, but the timing is unclear.`,
      `You noticed the room becoming quiet after ${room.incident.location} was mentioned.`
    ]);
    p.fakeRevealClue = null;
    p.objective = random([
      "Observe contradictions and avoid becoming the easiest accusation.",
      "Watch who changes their story under pressure.",
      "Stay believable and help the detective only when your information is useful."
    ]);
  });

  const frameTarget = random(others) || culprit;
  const decoyTarget = random(others.filter((p) => p.id !== frameTarget.id)) || frameTarget;

  culprit.role = "Culprit";
  culprit.confidence = random(["Medium", "High"]);
  culprit.clue = random([
    `SECRET: You arrived at ${room.incident.location} shortly before the incident. Someone may have noticed.`,
    `SECRET: Your timeline overlaps with the incident at ${room.incident.location}. If people compare details carefully, they may catch it.`,
    `SECRET: You left ${room.incident.location} without explaining why. That gap could become dangerous.`,
    `SECRET: You know a detail about ${room.incident.location} that nobody else should know.`,
    `SECRET: Evidence may eventually connect you to ${room.incident.location}, but it is not clear yet.`,
    `SECRET: You were close enough to ${room.incident.location} that a careful witness could become a problem.`
  ]);

  culprit.fakeRevealClue = random([
    `You heard movement near ${room.incident.location}, but you could not identify who it was.`,
    `You saw ${frameTarget.name} acting nervous after the incident, but you are not fully sure why.`,
    `You noticed ${decoyTarget.name} was unusually quiet when ${room.incident.location} was mentioned.`,
    `You remember a sound from ${room.incident.location}, but the timing felt confusing.`,
    `You saw people gathering near ${room.incident.location}, but nothing clearly proved who caused it.`,
    `You noticed someone leaving the area after the incident, but you only saw them briefly.`
  ]);

  culprit.objective = random([
    `Survive until reveal. Secret goal: make ${frameTarget.name} become the main suspect.`,
    `Survive until reveal. Secret goal: make at least one witness doubt their own clue.`,
    `Survive until reveal. Secret goal: get two other players arguing with each other.`,
    `Survive until reveal. Secret goal: use your fake reveal clue at the right moment to look helpful.`,
    `Survive until reveal. Secret goal: keep the detective uncertain until time runs out.`,
    `Survive until reveal. Secret goal: redirect discussion away from your movements.`
  ]) + " You also have one Anonymous Tip ability.";

  others.forEach((p, i) => {
    if (i % 3 === 0) {
      p.role = "Witness";
      p.confidence = random(["Medium", "High"]);
      p.clue = random([
        `You saw ${culprit.name} near ${room.incident.location} shortly before the incident.`,
        `${culprit.name} was one of the last people you noticed near ${room.incident.location}.`,
        `You heard ${culprit.name}'s name mentioned around the incident time.`,
        `You noticed ${culprit.name} leaving the area shortly after something felt wrong.`,
        `${culprit.name} appeared unusually tense when ${room.incident.location} was mentioned.`
      ]);
      p.objective = random([
        "Help the detective connect the dots without overstating your clue.",
        "Share what you know, but be careful: sounding too certain may backfire.",
        "Protect your credibility and help expose contradictions."
      ]);
    } else if (i % 3 === 1) {
      const wrong = random(room.players.filter((x) => x.id !== culprit.id && x.id !== p.id)) || culprit;
      p.role = "Misinformed";
      p.confidence = random(["Low", "Medium"]);
      p.clue = random([
        `You believe you saw ${wrong.name} near ${room.incident.location}, but visibility was poor.`,
        `${wrong.name} looked suspicious around ${room.incident.location}, though you are not completely certain.`,
        `You remember ${wrong.name} being nearby, but your memory feels fuzzy.`,
        `You think ${wrong.name} was involved somehow, though you have no proof.`,
        `${wrong.name} seemed nervous after the incident, but that may not mean anything.`
      ]);
      p.objective = random([
        "Defend your memory if challenged, but do not overplay weak information.",
        "Your clue may be wrong. Try not to become a distraction.",
        "Help if you can, but remember that confidence matters."
      ]);
    } else {
      p.role = "Observer";
      p.confidence = random(["Low", "Medium"]);
      p.clue = random([
        `You saw nothing directly, but noticed the room went quiet after the incident.`,
        `You heard a sound from ${room.incident.location}, but missed who was nearby.`,
        `You noticed someone changed the topic quickly after ${room.incident.location} was mentioned.`,
        `You remember tension rising after the incident, but no single person stood out.`,
        `You saw people watching each other carefully after the incident.`
      ]);
      p.objective = random([
        "Watch who contradicts themselves. You can support, challenge, or bluff.",
        "Stay useful without pretending to know more than you do.",
        "Read the room and avoid becoming easy suspicion."
      ]);
    }
  });
}

function generateAnonymousTip(room, culprit) {
  const targets = room.players.filter((p) => p.id !== culprit.id);
  const target = random(targets) || culprit;

  return random([
    `Someone has not been honest about their timing near ${room.incident.location}.`,
    `${target.name}'s story does not fully match what happened near ${room.incident.location}.`,
    `One player is pretending their clue is weaker than it really is.`,
    `The person who looked calmest after the incident may be hiding the most.`,
    `${target.name} reacted strangely when ${room.incident.location} was mentioned.`,
    `The loudest accusation may be covering up a quieter mistake.`
  ]);
}

function generateEvidence(room) {
  const culprit = room.players.find((p) => p.id === room.incident.culpritId);
  const decoy = random(room.players.filter((p) => p.id !== culprit.id)) || culprit;

  const hardExtra = room.settings.difficulty === "hard"
    ? [
        {
          type: "Contradictory Record",
          reliability: "Corrupted",
          text: `A damaged log appears to support both ${culprit.name} and ${decoy.name}.`
        }
      ]
    : [];

  return [
    {
      type: "Stable Evidence",
      reliability: "Stable",
      text: `The incident originated around ${room.incident.location}.`
    },
    {
      type: "Partial Timeline",
      reliability: "Unclear",
      text: `${culprit.name} appears near the timeline, but the record does not prove intent.`
    },
    {
      type: "Corrupted Signal",
      reliability: "Corrupted",
      text: `${decoy.name} appears in damaged data. This may be false, partial, or unrelated.`
    },
    ...hardExtra
  ];
}

function generateMidEvidence(room) {
  const culprit = room.players.find((p) => p.id === room.incident.culpritId);
  const decoy = random(room.players.filter((p) => p.id !== culprit.id)) || culprit;

  return random([
    {
      type: "Recovered Footage",
      reliability: "Stable",
      text: `Footage confirms someone left ${room.incident.location} shortly before the incident. The figure resembles ${culprit.name}.`
    },
    {
      type: "Audio Fragment",
      reliability: "Unclear",
      text: `A recovered audio clip mentions ${decoy.name}, but the context is missing.`
    },
    {
      type: "Corrected Log",
      reliability: "Stable",
      text: `Earlier corrupted data was partially restored. ${decoy.name}'s connection now looks weaker.`
    },
    {
      type: "New Timeline Detail",
      reliability: "Unclear",
      text: `${culprit.name} had a small time gap that has not been explained.`
    }
  ]);
}

function publicPlayers(players) {
  return players.map((p) => ({
    id: p.id,
    name: p.name,
    suspicion: p.suspicion || 0,
    score: p.score || 0
  }));
}

function emitRoomUpdate(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  io.to(roomId).emit("roomUpdate", {
    players: publicPlayers(room.players),
    state: room.state,
    roundNumber: room.roundNumber,
    minPlayers: room.settings.minPlayers,
    settings: room.settings,
    streamerName: room.streamerName,
    locked: room.locked
  });
}

function emitChat(roomId, player, message, tag) {
  io.to(roomId).emit("newMessage", {
    playerId: player.id,
    name: player.name,
    message,
    tag,
    time: new Date().toLocaleTimeString()
  });
}

function clearRoomTimer(room) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
}

function sanitizeName(name) {
  if (!name || typeof name !== "string") return "Anonymous";
  return name.trim().slice(0, 18) || "Anonymous";
}

function sanitizeMessage(message) {
  if (!message || typeof message !== "string") return "";
  return message.trim().slice(0, 140);
}

function random(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

const PORT = process.env.PORT || process.env.HOSTINGER_PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Running on port ${PORT}`);
});