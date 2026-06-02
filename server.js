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
  maxPlayers: 10,
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
      if (room.players.length >= room.settings.maxPlayers) {
        socket.emit("joinError", "This room is full.");
        return;
      }

      room.players.push({
        id: socket.id,
        name: cleanName,
        lastMessageAt: 0,
        role: null,
        clue: null,
        fakeRevealClue: null,
        publicAlibi: null,
        hiddenTruth: null,
        anonymousTip: null,
        observationQuality: null,
        confidence: null,
        objective: null,
        abilityName: "Anonymous Tip",
        abilityDescription: "Send one anonymous tip to create discussion.",
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
      maxPlayers: clamp(Number(settings.maxPlayers), 2, 50),
      roundTime: clamp(Number(settings.roundTime), 0, 3600),
      cooldown: clamp(Number(settings.cooldown), 1000, 15000),
      difficulty: ["easy", "normal", "hard"].includes(settings.difficulty)
        ? settings.difficulty
        : "normal"
    };

    if (room.settings.maxPlayers < room.settings.minPlayers) {
      room.settings.maxPlayers = room.settings.minPlayers;
    }

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

    if (action === "claim") {
      text = `I can explain my alibi if the detective asks.`;
    }

    if (action === "defend") {
      text = "My story has a reason. Ask me where I was and who could confirm it.";
    }

    if (action === "doubt") {
      text = `I doubt ${targetName}'s alibi. Something feels off.`;
    }

    if (action === "accuse") {
      text = `I think ${targetName} is hiding something.`;
    }

    if (action === "alibi") {
      text = `My public alibi: ${player.publicAlibi || "No alibi available."}`;
    }

    if (action === "anonymous") {
      if (player.anonymousUsed) {
        socket.emit("systemMessage", "You already used your Anonymous Tip this round.");
        return;
      }

      player.anonymousUsed = true;

      const anonymousText = player.anonymousTip || generateAnonymousTip(room, player);

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

      const revealClue = player.role === "Murderer" && player.fakeRevealClue
        ? player.fakeRevealClue
        : player.clue;

      io.to(roomId).emit("newMessage", {
        playerId: "anonymousReveal",
        name: "Anonymous Reveal",
        message: `Someone reveals: "${revealClue}" Observation Quality: ${player.observationQuality || player.confidence}.`,
        tag: "REVEAL",
        time: new Date().toLocaleTimeString()
      });

      io.to(player.id).emit("revealTokenUsed");
      io.to(roomId).emit("systemMessage", "An anonymous observation was revealed.");
      return;
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
    room.caseFile = generateCaseFile(room);
    assignAlibisRolesAndClues(room);

    room.evidence = generateInvestigationBoard(room);
    room.midEvidence = generateMidEvidence(room);
    room.suggestedQuestions = generateSuggestedQuestions(room);

    room.players.forEach((p) => {
      p.suspicion = 0;
      p.revealedClue = false;
      p.anonymousUsed = false;
      p.pressure = null;

      io.to(p.id).emit("privateData", {
        role: p.role,
        publicAlibi: p.publicAlibi,
        hiddenTruth: p.hiddenTruth,
        clue: p.clue,
        revealClue: p.role === "Murderer" && p.fakeRevealClue ? p.fakeRevealClue : p.clue,
        observationQuality: p.observationQuality,
        confidence: p.observationQuality,
        objective: p.objective,
        abilityName: p.abilityName,
        abilityDescription: p.abilityDescription,
        canUseAnonymous: true,
        caseFile: room.caseFile
      });

      io.to(p.id).emit("roundState", {
        state: "playing",
        roundNumber: room.roundNumber
      });
    });

    io.to(roomId).emit("roundStarted", {
      caseFile: room.caseFile,
      evidence: room.evidence,
      suggestedQuestions: room.suggestedQuestions,
      players: publicPlayers(room.players),
      roundNumber: room.roundNumber,
      timeLeft: room.timeLeft,
      unlimitedTime: room.settings.roundTime === 0,
      incidentTitle: room.caseFile.title,
      streamerName: room.streamerName
    });

    io.to(roomId).emit("soundCue", "start");
    emitRoomUpdate(roomId);

    if (room.settings.roundTime > 0) {
      room.timer = setInterval(() => {
        room.timeLeft -= 1;
        io.to(roomId).emit("timerUpdate", room.timeLeft);

        if (!room.midEvidenceDropped && room.timeLeft === Math.floor(room.settings.roundTime / 2)) {
          room.midEvidenceDropped = true;

          io.to(roomId).emit("midEvidenceDrop", room.midEvidence);
          io.to(roomId).emit("systemMessage", "🚨 New lead recovered. Re-check the alibis.");
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
    } else {
      io.to(roomId).emit("timerUpdate", 0);
      io.to(roomId).emit("systemMessage", "Story Mode enabled. No timer.");
    }
  });

  socket.on("interrogate", ({ roomId, playerId }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.streamer) return;

    const player = room.players.find((p) => p.id === playerId);
    if (!player) return;

    io.to(playerId).emit("interrogated");
    io.to(roomId).emit("systemMessage", `${player.name} is under pressure. Ask about their alibi.`);
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
        message: "Reveal one useful statement about your alibi, location, or observation. Do not dodge."
      });

      io.to(roomId).emit("systemMessage", `${player.name} must reveal one useful statement.`);
    }

    if (type === "spotlight") {
      room.spotlightPlayerId = player.id;

      io.to(player.id).emit("pressure", {
        type: "spotlight",
        message: "You are in the 20-second spotlight. Defend your alibi now."
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

    const murderer = room.players.find((p) => p.id === room.incident.culpritId);
    const accused = room.players.find((p) => p.id === room.accused);
    const success = room.accused === room.incident.culpritId;

    room.players.forEach((p) => {
      let gained = 0;

      if (p.role === "Murderer") gained = success ? 0 : 100;
      else if (p.role === "Witness") gained = success ? 100 : 25;
      else if (p.role === "Observer") gained = room.accused !== p.id ? 25 : 0;
      else gained = room.accused !== p.id ? 40 : 0;

      p.score += gained;
      p.lastGained = gained;
    });

    const witnesses = room.players.filter((p) => p.role === "Witness");
    const escaped = !success && murderer ? murderer.name : null;

    io.to(roomId).emit("reveal", {
      success,
      accusedPlayerName: accused ? accused.name : "No accusation",
      culpritName: murderer ? murderer.name : "Unknown",
      murdererName: murderer ? murderer.name : "Unknown",
      cause: room.incident.cause,
      location: room.incident.location,
      caseFile: room.caseFile,
      solution: room.incident.solution,
      helpers: witnesses.map((p) => p.name),
      misleaders: [],
      escaped,
      players: room.players.map((p) => ({
        name: p.name,
        role: p.role,
        publicAlibi: p.publicAlibi,
        hiddenTruth: p.hiddenTruth,
        clue: p.clue,
        fakeRevealClue: p.fakeRevealClue,
        observationQuality: p.observationQuality,
        confidence: p.observationQuality,
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
    caseFile: null,
    suggestedQuestions: [],
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

  const cases = [
    {
      title: "Emergency Lockdown",
      incident: "Restricted access was detected after curfew.",
      location: "Security Office",
      time: "8:37 PM",
      cause: "unauthorized access",
      object: "master access card",
      atmosphere: "The building went silent after the lockdown alarm.",
      solution: "The murderer used the confusion from the camera glitch to enter the restricted area."
    },
    {
      title: "Missing Prototype",
      incident: "A prototype device vanished during a short power failure.",
      location: "Research Lab",
      time: "9:12 PM",
      cause: "planned theft",
      object: "prototype device",
      atmosphere: "The backup lights flickered while everyone argued about where they had been.",
      solution: "The murderer moved during the blackout and used a false alibi to cover the gap."
    },
    {
      title: "The Broken Broadcast",
      incident: "A live broadcast feed was cut right before a key recording disappeared.",
      location: "Broadcast Room",
      time: "10:04 PM",
      cause: "sabotage",
      object: "recording drive",
      atmosphere: "The control desk was still warm when the others arrived.",
      solution: "The murderer interrupted the feed long enough to remove the recording drive."
    },
    {
      title: "The Vanished Ledger",
      incident: "A confidential ledger disappeared from a locked archive.",
      location: "Archive Room",
      time: "7:48 PM",
      cause: "cover-up",
      object: "confidential ledger",
      atmosphere: "Several people had reasons to be near the archive, but nobody wanted to admit it.",
      solution: "The murderer used an ordinary errand as cover to approach the archive."
    },
    {
      title: "The Reactor Alert",
      incident: "A false reactor alert pulled everyone away from their posts.",
      location: "Control Room",
      time: "11:19 PM",
      cause: "distraction",
      object: "reactor override key",
      atmosphere: "The alarm created panic, and everyone’s timeline became messy.",
      solution: "The murderer triggered the false alert to create a clean escape window."
    }
  ];

  const hardExtra = difficulty === "hard"
    ? " Some records contradict each other, so witness alibis matter more than the system logs."
    : "";

  const selected = { ...random(cases) };
  selected.culpritId = culprit.id;
  selected.difficultyNote = hardExtra;

  return selected;
}

function generateCaseFile(room) {
  const caseNumber = Math.floor(100 + Math.random() * 900);
  const knownFacts = [
    `${room.incident.location} is the center of the incident.`,
    `The incident happened around ${room.incident.time}.`,
    `Multiple people were moving nearby.`,
    `Records are incomplete, so alibis matter.`,
    `The ${room.incident.object} is connected to the incident.`
  ];

  return {
    number: caseNumber,
    title: `CASE #${caseNumber}: ${room.incident.title}`,
    location: room.incident.location,
    incident: room.incident.incident,
    time: room.incident.time,
    atmosphere: room.incident.atmosphere + (room.incident.difficultyNote || ""),
    knownFacts
  };
}

function assignAlibisRolesAndClues(room) {
  const murderer = room.players.find((p) => p.id === room.incident.culpritId);
  const others = room.players.filter((p) => p.id !== murderer.id).sort(() => Math.random() - 0.5);

  const locations = unique([
    room.incident.location,
    "Hallway",
    "Storage",
    "Cafeteria",
    "Lobby",
    "Server Room",
    "Generator Room",
    "West Corridor",
    "Meeting Room",
    "Maintenance Bay"
  ]);

  const actions = [
    "checking a noise",
    "looking for supplies",
    "fixing a small issue",
    "waiting for someone",
    "passing through",
    "checking the lights",
    "organizing equipment",
    "searching for a missing item",
    "talking to someone briefly",
    "trying to understand the alarm"
  ];

  room.players.forEach((p, index) => {
    const alibiLocation = locations[index % locations.length];
    const alibiAction = random(actions);

    p.publicAlibi = `You were in ${alibiLocation}, ${alibiAction}, around ${room.incident.time}.`;
    p.role = "Observer";
    p.observationQuality = random(["Low", "Medium"]);
    p.confidence = p.observationQuality;
    p.clue = random([
      `You heard movement somewhere near ${room.incident.location}, but you did not see who it was.`,
      `You noticed the area became tense after ${room.incident.time}.`,
      `You remember someone moving quickly, but you cannot identify them.`,
      `You heard people arguing about who was near ${room.incident.location}.`
    ]);
    p.fakeRevealClue = null;
    p.hiddenTruth = "";
    p.objective = random([
      "Compare alibis and watch who changes their story.",
      "Stay believable. Help the detective only when your observation is useful.",
      "Ask others where they were and look for contradictions."
    ]);
    p.abilityName = "Anonymous Tip";
    p.abilityDescription = "Once per round, send one anonymous tip to push discussion without revealing your name.";
    p.anonymousTip = generateAnonymousTip(room, p);
  });

  const frameTarget = random(others) || murderer;
  const decoyTarget = random(others.filter((p) => p.id !== frameTarget.id)) || frameTarget;

  murderer.role = "Murderer";
  murderer.observationQuality = random(["Medium", "High"]);
  murderer.confidence = murderer.observationQuality;
  murderer.publicAlibi = random([
    `You were in ${random(locations.filter((l) => l !== room.incident.location))}, ${random(actions)}, around ${room.incident.time}.`,
    `You were away from ${room.incident.location}, trying to understand the alarm, around ${room.incident.time}.`,
    `You were passing through the hallway and did not stay near ${room.incident.location}.`
  ]);

  murderer.hiddenTruth = random([
    `SECRET: You were actually near ${room.incident.location} when the incident happened.`,
    `SECRET: Your public alibi has a dangerous time gap around ${room.incident.time}.`,
    `SECRET: You know what happened to the ${room.incident.object}, but you cannot admit it.`,
    `SECRET: Someone may have noticed you close to ${room.incident.location}.`
  ]);

  murderer.clue = murderer.hiddenTruth;

  murderer.fakeRevealClue = random([
    `You heard movement near ${room.incident.location}, but you could not identify who it was.`,
    `You saw ${frameTarget.name} acting nervous after the incident, but you are not fully sure why.`,
    `You noticed ${decoyTarget.name} was unusually quiet when ${room.incident.location} was mentioned.`,
    `You remember a sound from ${room.incident.location}, but the timing felt confusing.`,
    `You saw people gathering near ${room.incident.location}, but nothing clearly proved who caused it.`
  ]);

  murderer.objective = random([
    `Survive until reveal. Secret goal: make ${frameTarget.name} become the main suspect.`,
    `Survive until reveal. Secret goal: make one strong witness doubt their own observation.`,
    `Survive until reveal. Secret goal: get two other players arguing with each other.`,
    `Survive until reveal. Secret goal: keep the detective uncertain until time runs out.`,
    `Survive until reveal. Secret goal: redirect discussion away from your real location.`
  ]);

  murderer.abilityName = "Anonymous Tip";
  murderer.abilityDescription = "Once per round, send one anonymous tip. Use it to redirect suspicion without exposing yourself.";
  murderer.anonymousTip = generateAnonymousTip(room, murderer);

  others.forEach((p, i) => {
    if (i % 3 === 0) {
      p.role = "Witness";
      p.observationQuality = random(["Medium", "High"]);
      p.confidence = p.observationQuality;
      p.clue = random([
        `You saw someone near ${room.incident.location} shortly before the incident, but only caught part of the movement.`,
        `You noticed a person leaving the area near ${room.incident.location}, but the angle was bad.`,
        `You heard footsteps moving away from ${room.incident.location} around ${room.incident.time}.`,
        `You remember someone reacting too quickly when ${room.incident.location} was mentioned.`
      ]);
      p.objective = random([
        "Help the detective connect alibis without overstating your observation.",
        "Share what you know, but be careful: sounding too certain may backfire.",
        "Protect your credibility and expose contradictions."
      ]);
    } else if (i % 3 === 1) {
      p.role = "Observer";
      p.observationQuality = random(["Low", "Medium"]);
      p.confidence = p.observationQuality;
      p.clue = random([
        `You believe someone was near ${room.incident.location}, but visibility was poor.`,
        `Someone looked suspicious after the incident, though you are not completely certain.`,
        `You remember movement nearby, but your memory feels fuzzy.`,
        `You think one alibi sounds too clean, though you have no proof.`
      ]);
      p.objective = random([
        "Question clean alibis and listen for contradictions.",
        "Your information is weak. Use it carefully.",
        "Help if you can, but do not pretend your observation is stronger than it is."
      ]);
    } else {
      p.role = "Drifter";
      p.observationQuality = random(["Low", "Medium"]);
      p.confidence = p.observationQuality;
      p.clue = random([
        `You were moving between rooms, so your own alibi may sound messy.`,
        `You saw people watching each other carefully after the incident.`,
        `You noticed someone changed the topic quickly after ${room.incident.location} was mentioned.`,
        `You remember tension rising after the incident, but no single person stood out.`
      ]);
      p.objective = random([
        "Your movement may make you suspicious. Explain yourself clearly.",
        "Survive suspicion while helping the detective compare timelines.",
        "Use your messy alibi to bait contradictions from others."
      ]);
    }

    p.abilityName = "Anonymous Tip";
    p.abilityDescription = "Once per round, send one anonymous tip to push discussion without revealing your name.";
    p.anonymousTip = generateAnonymousTip(room, p);
  });
}

function generateInvestigationBoard(room) {
  return [
    {
      type: "Case Fact",
      reliability: "Stable",
      text: `${room.incident.location} is confirmed as the center of the incident.`
    },
    {
      type: "Timeline Fact",
      reliability: "Stable",
      text: `The incident happened around ${room.incident.time}, but movement records are incomplete.`
    },
    {
      type: "Open Lead",
      reliability: "Questionable",
      text: `Someone was near ${room.incident.location} close to the incident time. Identity unclear.`
    },
    {
      type: "Alibi Lead",
      reliability: "Questionable",
      text: `At least one public alibi may have a timing gap. Compare stories carefully.`
    },
    {
      type: "System Note",
      reliability: "Corrupted",
      text: `Recovered logs are partial. They can support theories, but cannot solve the case alone.`
    }
  ];
}

function generateMidEvidence(room) {
  return random([
    {
      type: "Recovered Movement",
      reliability: "Questionable",
      text: `Recovered footage shows movement near ${room.incident.location}. Identity unclear.`
    },
    {
      type: "Audio Fragment",
      reliability: "Questionable",
      text: `A short audio fragment captured hurried movement, but no clear voice.`
    },
    {
      type: "Corrected Log",
      reliability: "Stable",
      text: `The timeline confirms the incident window, but not who caused it. Alibis still matter most.`
    },
    {
      type: "New Lead",
      reliability: "Questionable",
      text: `One story may not match the incident timing. Re-question players about where they were.`
    }
  ]);
}

function generateSuggestedQuestions(room) {
  return [
    `Where were you at ${room.incident.time}?`,
    `Who can confirm your alibi?`,
    `Why were you near that area?`,
    `Did you hear or see anything near ${room.incident.location}?`,
    `Whose story changed after pressure?`,
    `Who sounds too certain for a weak observation?`,
    `Which alibi has the biggest time gap?`
  ];
}

function generateAnonymousTip(room, player) {
  const targets = room.players.filter((p) => p.id !== player.id);
  const target = random(targets) || player;

  return random([
    `Someone has not been honest about their timing near ${room.incident.location}.`,
    `${target.name}'s alibi may not fully match the incident window.`,
    `One player is pretending their observation is weaker than it really is.`,
    `The person who looked calmest after the incident may be hiding the most.`,
    `${target.name} reacted strangely when ${room.incident.location} was mentioned.`,
    `The cleanest alibi may be the most rehearsed.`,
    `Someone avoided explaining where they were at ${room.incident.time}.`
  ]);
}

function publicPlayers(players) {
  return players.map((p) => ({
    id: p.id,
    name: p.name,
    suspicion: p.suspicion || 0,
    score: p.score || 0,
    publicAlibi: p.publicAlibi || "No alibi yet."
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
    maxPlayers: room.settings.maxPlayers,
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
  return message.trim().slice(0, 180);
}

function random(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function unique(arr) {
  return [...new Set(arr)];
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

const PORT = process.env.PORT || process.env.HOSTINGER_PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Running on port ${PORT}`);
});