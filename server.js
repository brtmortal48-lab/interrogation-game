const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server);

const rooms = {};
const PROFILE_FILE = path.join(__dirname, "profiles.json");
const playerProfiles = loadProfiles();

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

  socket.on("createProfile", ({ name }) => {
    const cleanName = sanitizeName(name || "Player");
    const profile = createPersistentProfile(cleanName);
    socket.emit("profileCreated", {
      profileCode: profile.id,
      profile: getProfileStats(profile.id)
    });
  });

  socket.on("loadProfile", ({ profileCode }) => {
    const code = normalizeProfileCode(profileCode);
    const profile = code ? playerProfiles[code] : null;

    if (!profile) {
      socket.emit("profileError", "Profile not found. Check the Profile ID or create a new profile.");
      return;
    }

    socket.emit("profileLoaded", {
      profileCode: profile.id,
      profile: getProfileStats(profile.id)
    });
  });

  socket.on("renameProfile", ({ profileCode, name }) => {
    const code = normalizeProfileCode(profileCode);
    const profile = code ? playerProfiles[code] : null;

    if (!profile) {
      socket.emit("profileError", "Profile not found.");
      return;
    }

    profile.name = sanitizeName(name || profile.name);
    saveProfiles();
    socket.emit("profileLoaded", {
      profileCode: profile.id,
      profile: getProfileStats(profile.id)
    });
  });

  socket.on("joinRoom", ({ roomId, role, name, hostKey, profileCode }) => {
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
      emitVoteUpdate(roomId);
      return;
    }

    if (role === "voter") {
      emitRoomUpdate(roomId);
      emitVoteUpdate(roomId);
      return;
    }

    if (role !== "player") return;

    const requestedProfileCode = normalizeProfileCode(profileCode);
    const linkedProfile = requestedProfileCode ? playerProfiles[requestedProfileCode] : null;
    const cleanName = sanitizeName(name || linkedProfile?.name || "Player");
    const playerProfile = linkedProfile || createPersistentProfile(cleanName);

    if (linkedProfile && cleanName && cleanName !== linkedProfile.name) {
      linkedProfile.name = cleanName;
      saveProfiles();
    }

    const duplicate = room.players.find(
      (p) => (p.profileId === playerProfile.id || p.name.toLowerCase() === cleanName.toLowerCase()) && p.id !== socket.id
    );

    if (duplicate) {
      socket.emit("joinError", "That profile or name is already in this room.");
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
        abilityName: "Special Ability",
        abilityDescription: "Your role ability will appear when the round starts.",
        suspicion: 0,
        revealedClue: false,
        anonymousUsed: false,
        abilityUsed: false,
        bonusObjective: "",
        bonusCompleted: false,
        bonusTargetId: null,
        bonusTargetName: null,
        score: 0,
        pressure: null,
        profileId: playerProfile.id
      });

      socket.emit("profileLinked", {
        profileCode: playerProfile.id,
        profile: getProfileStats(playerProfile.id)
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

    if (player.pressure === "alibi") {
      player.pressure = null;
      io.to(player.id).emit("pressureCleared");
      io.to(player.id).emit("streamEventCleared", { type: "forceAlibis" });
    }

    detectContradiction(roomId, room, player, clean);
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

    if (action === "claim") text = "I can explain my alibi if the detective asks.";
    if (action === "defend") text = "My story has a reason. Ask me where I was and who could confirm it.";
    if (action === "doubt") text = `I doubt ${targetName}'s alibi. Something feels off.`;
    if (action === "accuse") text = `I think ${targetName} is hiding something.`;
    if (action === "alibi") {
      text = `My public alibi: ${player.publicAlibi || "No alibi available."}`;
      if (player.pressure === "alibi") {
        player.pressure = null;
        io.to(player.id).emit("pressureCleared");
        io.to(player.id).emit("streamEventCleared", { type: "forceAlibis" });
      }
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

    if (action === "ability") {
      useRoleAbility(roomId, room, player, target);
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
    room.viewerVotes = {};
    room.playerVotes = {};
    room.activeStreamEvent = null;
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
      p.abilityUsed = false;
      p.bonusCompleted = false;
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
        bonusObjective: p.bonusObjective,
        abilityName: p.abilityName,
        abilityDescription: p.abilityDescription,
        canUseAnonymous: true,
        caseFile: room.caseFile,
        profileCode: p.profileId,
        profileStats: getProfileStats(p.profileId || p.name)
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
      viewerVotes: voteSummary(room),
      playerVotes: playerVoteSummary(room),
      activeStreamEvent: room.activeStreamEvent,
      voteLink: `/vote.html?room=${roomId}`,
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


  socket.on("streamEvent", ({ roomId, type }) => {
    roomId = String(roomId || "").trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || socket.id !== room.streamer) return;

    triggerStreamEvent(roomId, room, type);
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
      else if (p.role === "Accomplice") gained = success ? 15 : 80;
      else if (p.role === "Witness") gained = success ? 100 : 25;
      else if (p.role === "Guard" || p.role === "Journalist" || p.role === "Informant" || p.role === "Lawyer" || p.role === "Analyst") gained = success ? 75 : 20;
      else gained = room.accused !== p.id ? 40 : 0;

      p.score += gained;
      p.lastGained = gained;
    });

    evaluateBonusObjectives(room, murderer, accused, success);
    updatePlayerProfiles(room, success);

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
      resolutionSteps: generateResolutionSteps(room, murderer, accused, success),
      contradictions: room.contradictions || [],
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
        bonusObjective: p.bonusObjective,
        bonusCompleted: p.bonusCompleted,
        profileStats: getProfileStats(p.profileId || p.name),
        suspicion: p.suspicion,
        score: p.score,
        gained: p.lastGained || 0
      }))
    });

    io.to(roomId).emit("soundCue", success ? "success" : "fail");
    emitRoomUpdate(roomId);
  });


  socket.on("playerVoteCast", ({ roomId, playerId }) => {
    roomId = String(roomId || "").trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    const voter = room.players.find((p) => p.id === socket.id);
    const target = room.players.find((p) => p.id === playerId);
    if (!voter || !target) return;

    room.playerVotes[voter.id] = target.id;
    io.to(roomId).emit("playerVoteUpdate", { playerVotes: playerVoteSummary(room) });
    io.to(voter.id).emit("systemMessage", `Your emergency vote is on ${target.name}.`);
  });

  socket.on("voteCast", ({ roomId, voterId, playerId }) => {
    if (!roomId || !voterId || !playerId) return;

    roomId = String(roomId).trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find((p) => p.id === playerId);
    if (!player) return;

    room.viewerVotes[String(voterId).slice(0, 64)] = playerId;
    emitVoteUpdate(roomId);
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


function triggerStreamEvent(roomId, room, type) {
  if (!room || room.players.length === 0) return;

  if (type === "forceAlibis") {
    const event = {
      type,
      icon: "📢",
      title: "FORCE ALIBIS",
      message: "Everyone must answer: Where were you? What were you doing? Who can verify it?",
      seconds: 30
    };
    room.activeStreamEvent = event;

    room.players.forEach((p) => {
      p.pressure = "alibi";
      io.to(p.id).emit("streamEvent", event);
      io.to(p.id).emit("pressure", {
        type: "alibi",
        message: "STREAM EVENT: State your alibi. Where were you, what were you doing, and who can verify it?"
      });
    });

    io.to(roomId).emit("streamEvent", event);
    io.to(roomId).emit("systemMessage", "📢 Stream Event: everyone must state their alibi.");
    io.to(roomId).emit("soundCue", "pressure");
    return;
  }

  if (type === "randomSpotlight") {
    const player = random(room.players);
    if (!player) return;

    const event = {
      type,
      icon: "🎯",
      title: "RANDOM SPOTLIGHT",
      message: `${player.name} has been selected. Defend your alibi now.`,
      playerId: player.id,
      playerName: player.name,
      seconds: 20
    };
    room.activeStreamEvent = event;
    room.spotlightPlayerId = player.id;

    io.to(player.id).emit("streamEvent", event);
    io.to(player.id).emit("pressure", {
      type: "spotlight",
      message: "Random Spotlight: defend your alibi right now."
    });
    io.to(roomId).emit("streamEvent", event);
    io.to(roomId).emit("spotlight", { playerId: player.id, playerName: player.name, seconds: 20 });
    io.to(roomId).emit("systemMessage", `🎯 Random Spotlight selected ${player.name}.`);
    io.to(roomId).emit("soundCue", "pressure");

    setTimeout(() => {
      if (rooms[roomId]) {
        rooms[roomId].spotlightPlayerId = null;
        io.to(roomId).emit("spotlightEnd");
        io.to(player.id).emit("pressureCleared");
      }
    }, 20000);
    return;
  }

  if (type === "emergencyVote") {
    room.viewerVotes = {};
    room.playerVotes = {};

    const event = {
      type,
      icon: "🗳",
      title: "EMERGENCY VOTE",
      message: "Everyone vote now. Viewers and players choose who looks most suspicious.",
      seconds: 45
    };
    room.activeStreamEvent = event;

    room.players.forEach((p) => io.to(p.id).emit("streamEvent", event));
    io.to(roomId).emit("streamEvent", event);
    io.to(roomId).emit("playerVoteUpdate", { playerVotes: playerVoteSummary(room) });
    emitVoteUpdate(roomId);
    io.to(roomId).emit("systemMessage", "🗳 Emergency Vote started. Viewer and player votes reset.");
    io.to(roomId).emit("soundCue", "accuse");
    return;
  }

  if (type === "newLead") {
    const lead = generateStreamEventLead(room);
    room.evidence.push(lead);

    const event = {
      type,
      icon: "🔎",
      title: "NEW LEAD",
      message: lead.text,
      seconds: 15
    };
    room.activeStreamEvent = event;

    io.to(roomId).emit("streamEvent", event);
    io.to(roomId).emit("midEvidenceDrop", lead);
    io.to(roomId).emit("systemMessage", "🔎 Stream Event: a fresh lead entered the investigation.");
    io.to(roomId).emit("soundCue", "twist");
  }
}

function generateStreamEventLead(room) {
  return random([
    {
      type: "Stream Lead",
      reliability: "Questionable",
      text: `A recovered witness note says someone left ${room.incident.location} shortly before the incident. Identity unclear.`
    },
    {
      type: "Stream Lead",
      reliability: "Questionable",
      text: `A fresh report says one alibi sounded too rehearsed, but the report does not name anyone.`
    },
    {
      type: "Stream Lead",
      reliability: "Corrupted",
      text: `A damaged record confirms movement near ${room.incident.location}, but the figure cannot be identified.`
    },
    {
      type: "Stream Lead",
      reliability: "Questionable",
      text: `Someone may have changed their story after pressure. Re-check the first alibis.`
    }
  ]);
}

function assignBonusObjectives(room, murderer, frameTarget) {
  room.players.forEach((p) => {
    p.bonusCompleted = false;
    p.bonusTargetId = null;
    p.bonusTargetName = null;

    if (p.role === "Murderer") {
      const target = frameTarget && frameTarget.id !== p.id ? frameTarget : random(room.players.filter((x) => x.id !== p.id));
      p.bonusTargetId = target ? target.id : null;
      p.bonusTargetName = target ? target.name : null;
      p.bonusObjective = target
        ? `Bonus: make ${target.name} become the final accusation or strongest suspect.`
        : "Bonus: make another player take the blame.";
      return;
    }

    if (p.role === "Accomplice") {
      p.bonusTargetId = murderer ? murderer.id : null;
      p.bonusTargetName = murderer ? murderer.name : null;
      p.bonusObjective = murderer
        ? `Bonus: keep ${murderer.name} from being accused.`
        : "Bonus: help the murderer escape.";
      return;
    }

    if (p.role === "Witness") {
      p.bonusObjective = "Bonus: help the detective accuse the real murderer.";
      return;
    }

    if (p.role === "Guard") {
      p.bonusObjective = "Bonus: use Protect Alibi on someone who ends below 30 suspicion.";
      return;
    }

    if (p.role === "Journalist") {
      p.bonusObjective = "Bonus: use Anonymous Report before the reveal.";
      return;
    }

    if (p.role === "Informant") {
      p.bonusObjective = "Bonus: use Private Hint and help create a useful interrogation.";
      return;
    }

    if (p.role === "Lawyer") {
      p.bonusObjective = "Bonus: defend someone who survives below 40 suspicion.";
      return;
    }

    if (p.role === "Analyst") {
      p.bonusObjective = "Bonus: publish System Analysis before the reveal.";
      return;
    }

    if (p.role === "Drifter") {
      p.bonusObjective = "Bonus: survive the round while staying below 50 suspicion.";
      return;
    }

    p.bonusObjective = "Bonus: avoid becoming the final accusation.";
  });
}

function evaluateBonusObjectives(room, murderer, accused, success) {
  room.players.forEach((p) => {
    let completed = false;

    if (p.role === "Murderer") {
      completed = !!accused && accused.id !== p.id;
    } else if (p.role === "Accomplice") {
      completed = !!murderer && !!accused && accused.id !== murderer.id;
    } else if (p.role === "Witness") {
      completed = success;
    } else if (p.role === "Guard") {
      const target = room.players.find((x) => x.id === p.abilityTargetId);
      completed = p.abilityUsed && !!target && (target.suspicion || 0) < 30;
    } else if (p.role === "Lawyer") {
      const target = room.players.find((x) => x.id === p.abilityTargetId);
      completed = p.abilityUsed && !!target && (target.suspicion || 0) < 40;
    } else if (p.role === "Drifter") {
      completed = (p.suspicion || 0) < 50 && (!accused || accused.id !== p.id);
    } else if (["Journalist", "Informant", "Analyst"].includes(p.role)) {
      completed = !!p.abilityUsed;
    } else {
      completed = !accused || accused.id !== p.id;
    }

    p.bonusCompleted = completed;
    if (completed) p.score += 25;
  });
}

function playerVoteSummary(room) {
  const counts = {};
  Object.values(room.playerVotes || {}).forEach((playerId) => {
    counts[playerId] = (counts[playerId] || 0) + 1;
  });

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

  return room.players
    .map((p) => {
      const votes = counts[p.id] || 0;
      return {
        id: p.id,
        name: p.name,
        votes,
        percent: total ? Math.round((votes / total) * 100) : 0
      };
    })
    .sort((a, b) => b.votes - a.votes);
}

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
    viewerVotes: {},
    playerVotes: {},
    activeStreamEvent: null,
    statementHistory: [],
    contradictions: [],
    settings: { ...DEFAULT_SETTINGS }
  };
}

function useRoleAbility(roomId, room, player, target) {
  if (player.abilityUsed) {
    io.to(player.id).emit("systemMessage", "You already used your special ability this round.");
    return;
  }

  player.abilityUsed = true;

  if (player.role === "Murderer") {
    io.to(roomId).emit("newMessage", {
      playerId: "falseLead",
      name: "Anonymous Lead",
      message: generateFalseLead(room, player),
      tag: "LEAD",
      time: new Date().toLocaleTimeString()
    });
    io.to(player.id).emit("abilityUsed");
    io.to(roomId).emit("systemMessage", "A new anonymous lead entered the investigation.");
    return;
  }

  if (player.role === "Accomplice") {
    io.to(roomId).emit("newMessage", {
      playerId: "coverStory",
      name: "Anonymous Support",
      message: "Someone claims one suspicious alibi may have been misunderstood.",
      tag: "COVER",
      time: new Date().toLocaleTimeString()
    });
    io.to(player.id).emit("abilityUsed");
    io.to(roomId).emit("systemMessage", "An anonymous cover story was added.");
    return;
  }

  if (player.role === "Witness") {
    io.to(roomId).emit("newMessage", {
      playerId: "witnessPush",
      name: "Anonymous Witness",
      message: `A witness insists: "${player.clue}"`,
      tag: "WITNESS",
      time: new Date().toLocaleTimeString()
    });
    io.to(player.id).emit("abilityUsed");
    return;
  }

  if (player.role === "Guard") {
    if (!target) {
      io.to(player.id).emit("systemMessage", "Choose a player to protect.");
      player.abilityUsed = false;
      return;
    }

    target.suspicion = Math.max(0, target.suspicion - 20);
    player.abilityTargetId = target.id;
    player.abilityTargetName = target.name;
    io.to(roomId).emit("systemMessage", `Someone quietly protected ${target.name}'s alibi. Suspicion reduced.`);
    io.to(player.id).emit("abilityUsed");
    emitRoomUpdate(roomId);
    io.to(roomId).emit("suspicionUpdate", { players: publicPlayers(room.players) });
    return;
  }

  if (player.role === "Journalist") {
    io.to(roomId).emit("newMessage", {
      playerId: "journalistReport",
      name: "Anonymous Report",
      message: random([
        "A report claims one player avoided explaining their exact location.",
        "A report says the cleanest alibi may have been rehearsed.",
        "A report suggests someone changed tone after the case file was read."
      ]),
      tag: "REPORT",
      time: new Date().toLocaleTimeString()
    });
    io.to(player.id).emit("abilityUsed");
    return;
  }

  if (player.role === "Informant") {
    const hint = random([
      `Private hint: focus on who was closest to ${room.incident.location}.`,
      `Private hint: one strong alibi may still have a timing gap.`,
      `Private hint: compare who spoke first with who gave details later.`,
      `Private hint: the murderer benefits when players chase weak observations.`
    ]);

    io.to(player.id).emit("systemMessage", hint);
    io.to(player.id).emit("abilityUsed");
    return;
  }

  if (player.role === "Lawyer") {
    if (!target) {
      io.to(player.id).emit("systemMessage", "Choose a player to defend.");
      player.abilityUsed = false;
      return;
    }

    target.suspicion = Math.max(0, target.suspicion - 25);
    player.abilityTargetId = target.id;
    player.abilityTargetName = target.name;
    io.to(roomId).emit("systemMessage", `${target.name}'s story was defended. Suspicion reduced.`);
    io.to(player.id).emit("abilityUsed");
    emitRoomUpdate(roomId);
    io.to(roomId).emit("suspicionUpdate", { players: publicPlayers(room.players) });
    return;
  }

  if (player.role === "Analyst") {
    io.to(roomId).emit("newMessage", {
      playerId: "analysis",
      name: "System Analysis",
      message: random([
        `Analysis: the incident window around ${room.incident.time} still matters more than direct accusations.`,
        `Analysis: at least one alibi has a weak confirmation point.`,
        `Analysis: the current evidence does not identify anyone directly.`,
        `Analysis: players should compare who was near ${room.incident.location}.`
      ]),
      tag: "ANALYSIS",
      time: new Date().toLocaleTimeString()
    });
    io.to(player.id).emit("abilityUsed");
    return;
  }

  if (player.role === "Drifter") {
    io.to(roomId).emit("newMessage", {
      playerId: "timelineNoise",
      name: "Timeline Noise",
      message: "Someone's movement route was messy enough to confuse the timeline.",
      tag: "TIMELINE",
      time: new Date().toLocaleTimeString()
    });
    io.to(player.id).emit("abilityUsed");
    return;
  }

  io.to(roomId).emit("newMessage", {
    playerId: "observerNote",
    name: "Anonymous Note",
    message: player.anonymousTip || generateAnonymousTip(room, player),
    tag: "NOTE",
    time: new Date().toLocaleTimeString()
  });
  io.to(player.id).emit("abilityUsed");
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
    p.objective = "Compare alibis and watch who changes their story.";
    p.abilityName = "Anonymous Note";
    p.abilityDescription = "Send one vague anonymous note to keep the discussion moving.";
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
  murderer.abilityName = "Plant False Lead";
  murderer.abilityDescription = "Once per round, inject a misleading anonymous lead into the investigation.";
  murderer.anonymousTip = generateAnonymousTip(room, murderer);

  const roleCycle = ["Witness", "Observer", "Drifter", "Guard", "Journalist", "Informant", "Lawyer", "Analyst"];

  if (others.length >= 5) {
    const accomplice = others[0];
    accomplice.role = "Accomplice";
    accomplice.observationQuality = "Medium";
    accomplice.confidence = "Medium";
    accomplice.hiddenTruth = `SECRET: You know ${murderer.name} is connected to the incident. Protect them without making it obvious.`;
    accomplice.clue = `You know the murderer is trying to hide a timing gap, but you must not expose them.`;
    accomplice.fakeRevealClue = `You saw confusion near ${room.incident.location}, but cannot identify who caused it.`;
    accomplice.objective = `Help ${murderer.name} survive. Redirect suspicion without looking coordinated.`;
    accomplice.abilityName = "Cover Story";
    accomplice.abilityDescription = "Once per round, anonymously defend a suspicious alibi.";
    accomplice.anonymousTip = generateAnonymousTip(room, accomplice);
  }

  others.forEach((p, i) => {
    if (p.role === "Accomplice") return;

    const role = roleCycle[i % roleCycle.length];
    p.role = role;

    if (role === "Witness") {
      p.observationQuality = random(["Medium", "High"]);
      p.clue = random([
        `You saw someone near ${room.incident.location} shortly before the incident, but only caught part of the movement.`,
        `You noticed a person leaving the area near ${room.incident.location}, but the angle was bad.`,
        `You heard footsteps moving away from ${room.incident.location} around ${room.incident.time}.`,
        `You remember someone reacting too quickly when ${room.incident.location} was mentioned.`
      ]);
      p.objective = "Help the detective connect alibis without overstating your observation.";
      p.abilityName = "Witness Push";
      p.abilityDescription = "Once per round, anonymously push your observation into chat with stronger wording.";
    }

    if (role === "Observer") {
      p.observationQuality = random(["Low", "Medium"]);
      p.clue = random([
        `You believe someone was near ${room.incident.location}, but visibility was poor.`,
        `Someone looked suspicious after the incident, though you are not completely certain.`,
        `You remember movement nearby, but your memory feels fuzzy.`
      ]);
      p.objective = "Question clean alibis and listen for contradictions.";
      p.abilityName = "Anonymous Note";
      p.abilityDescription = "Once per round, send a vague anonymous note to stir discussion.";
    }

    if (role === "Drifter") {
      p.observationQuality = random(["Low", "Medium"]);
      p.clue = random([
        `You were moving between rooms, so your own alibi may sound messy.`,
        `You saw people watching each other carefully after the incident.`,
        `You noticed someone changed the topic quickly after ${room.incident.location} was mentioned.`
      ]);
      p.objective = "Your movement may make you suspicious. Explain yourself clearly.";
      p.abilityName = "Timeline Noise";
      p.abilityDescription = "Once per round, create anonymous timeline confusion.";
    }

    if (role === "Guard") {
      p.observationQuality = random(["Medium", "High"]);
      p.clue = `You noticed someone trying to stay calm after the incident, but you could not tell if it was fear or guilt.`;
      p.objective = "Protect a player whose alibi you believe.";
      p.abilityName = "Protect Alibi";
      p.abilityDescription = "Once per round, choose a player and reduce their suspicion by 20.";
    }

    if (role === "Journalist") {
      p.observationQuality = random(["Medium", "High"]);
      p.clue = `You noticed the discussion changed whenever ${room.incident.location} was mentioned.`;
      p.objective = "Publish pressure into the room and force people to respond.";
      p.abilityName = "Anonymous Report";
      p.abilityDescription = "Once per round, publish an anonymous report to the room.";
    }

    if (role === "Informant") {
      p.observationQuality = random(["Medium", "High"]);
      p.clue = `You have a weak connection to hidden information, but need to ask the right questions.`;
      p.objective = "Use your private hint to guide questioning carefully.";
      p.abilityName = "Private Hint";
      p.abilityDescription = "Once per round, receive a private hint only you can see.";
    }

    if (role === "Lawyer") {
      p.observationQuality = random(["Low", "Medium"]);
      p.clue = `You are good at spotting when people are being accused too quickly.`;
      p.objective = "Defend someone who may be wrongly targeted.";
      p.abilityName = "Defend Player";
      p.abilityDescription = "Once per round, choose a player and reduce their suspicion by 25.";
    }

    if (role === "Analyst") {
      p.observationQuality = random(["Medium", "High"]);
      p.clue = `You noticed the system records are incomplete but still useful for checking timelines.`;
      p.objective = "Use system logic to help the room compare alibis.";
      p.abilityName = "System Analysis";
      p.abilityDescription = "Once per round, publish a system-style analysis lead.";
    }

    p.confidence = p.observationQuality;
    p.hiddenTruth = p.hiddenTruth || "";
    p.fakeRevealClue = p.fakeRevealClue || null;
    p.anonymousTip = generateAnonymousTip(room, p);
  });

  assignBonusObjectives(room, murderer, frameTarget);
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

function generateFalseLead(room, player) {
  const targets = room.players.filter((p) => p.id !== player.id);
  const target = random(targets) || player;

  return random([
    `${target.name}'s alibi may have a missing detail.`,
    `Someone claims ${target.name} reacted strangely after the incident.`,
    `A vague lead suggests the obvious suspect may not be the only suspicious person.`,
    `The timeline around ${room.incident.time} may not be as clean as it sounds.`,
    `Someone near ${room.incident.location} may be protecting another player.`
  ]);
}

function voteSummary(room) {
  const counts = {};
  room.players.forEach((p) => {
    counts[p.id] = 0;
  });

  Object.values(room.viewerVotes || {}).forEach((playerId) => {
    if (counts[playerId] !== undefined) counts[playerId] += 1;
  });

  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

  return room.players.map((p) => ({
    id: p.id,
    name: p.name,
    votes: counts[p.id] || 0,
    percent: total ? Math.round(((counts[p.id] || 0) / total) * 100) : 0
  })).sort((a, b) => b.votes - a.votes);
}

function emitVoteUpdate(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  io.to(roomId).emit("voteUpdate", {
    players: publicPlayers(room.players),
    viewerVotes: voteSummary(room)
  });
}


function detectContradiction(roomId, room, player, message) {
  const currentLocation = extractLocation(message, room);
  const alibiLocation = extractLocation(player.publicAlibi || "", room);

  const previousStatements = (room.statementHistory || []).filter((s) => s.playerId === player.id);
  const previousWithLocation = [...previousStatements].reverse().find((s) => s.location);

  const statement = {
    playerId: player.id,
    playerName: player.name,
    message,
    location: currentLocation,
    time: new Date().toLocaleTimeString()
  };

  room.statementHistory = room.statementHistory || [];
  room.statementHistory.push(statement);
  room.statementHistory = room.statementHistory.slice(-80);

  if (!currentLocation) return;

  let earlier = null;
  let earlierLocation = null;
  let reason = "";

  if (previousWithLocation && previousWithLocation.location !== currentLocation) {
    earlier = previousWithLocation.message;
    earlierLocation = previousWithLocation.location;
    reason = "This player mentioned a different location earlier.";
  } else if (alibiLocation && alibiLocation !== currentLocation) {
    earlier = player.publicAlibi;
    earlierLocation = alibiLocation;
    reason = "This statement may conflict with their public alibi.";
  }

  if (!earlier || !earlierLocation) return;

  const duplicate = (room.contradictions || []).some((c) =>
    c.playerId === player.id &&
    c.earlierLocation === earlierLocation &&
    c.currentLocation === currentLocation
  );

  if (duplicate) return;

  const contradiction = {
    playerId: player.id,
    playerName: player.name,
    earlier,
    current: message,
    earlierLocation,
    currentLocation,
    reason,
    time: new Date().toLocaleTimeString()
  };

  room.contradictions = room.contradictions || [];
  room.contradictions.unshift(contradiction);
  room.contradictions = room.contradictions.slice(0, 8);

  player.suspicion = Math.max(0, Math.min(100, (player.suspicion || 0) + 10));

  io.to(roomId).emit("contradictionFound", contradiction);
  io.to(roomId).emit("suspicionUpdate", { players: publicPlayers(room.players) });
  io.to(roomId).emit("soundCue", "twist");
}

function extractLocation(text, room) {
  if (!text || !room || !room.incident) return null;

  const knownLocations = unique([
    room.incident.location,
    "Security Office",
    "Research Lab",
    "Broadcast Room",
    "Archive Room",
    "Control Room",
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

  const lower = String(text).toLowerCase();
  const found = knownLocations.find((location) => lower.includes(location.toLowerCase()));
  return found || null;
}

function generateResolutionSteps(room, murderer, accused, success) {
  const caseFile = room.caseFile || {};
  const murdererName = murderer ? murderer.name : "Unknown";
  const accusedName = accused ? accused.name : "No one";
  const strongestContradiction = (room.contradictions || [])[0];

  const steps = [
    `At ${room.incident.time}, the incident began near ${room.incident.location}.`,
    `Most players gave public alibis, but at least one timeline had to be compared carefully.`,
    `${murdererName}'s real connection to ${room.incident.location} was hidden behind a public alibi.`,
    room.incident.solution || `The murderer used the confusion around ${room.incident.location} to avoid suspicion.`
  ];

  if (strongestContradiction) {
    steps.splice(2, 0, `${strongestContradiction.playerName} created a contradiction: ${strongestContradiction.earlierLocation} vs ${strongestContradiction.currentLocation}.`);
  }

  steps.push(success
    ? `The detective accused ${accusedName}, which exposed the murderer correctly.`
    : `The detective accused ${accusedName}, allowing ${murdererName} to escape.`
  );

  return steps;
}



function loadProfiles() {
  try {
    if (!fs.existsSync(PROFILE_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch (err) {
    console.warn("Could not load profiles.json:", err.message);
    return {};
  }
}

function saveProfiles() {
  try {
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(playerProfiles, null, 2));
  } catch (err) {
    console.warn("Could not save profiles.json:", err.message);
  }
}

function normalizeProfileCode(code) {
  if (!code || typeof code !== "string") return "";
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");
}

function generateProfileCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let raw = "";
  do {
    raw = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (playerProfiles[`${raw.slice(0, 4)}-${raw.slice(4)}`]);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function createPersistentProfile(name) {
  const cleanName = sanitizeName(name || "Player");
  const id = generateProfileCode();
  playerProfiles[id] = {
    id,
    name: cleanName,
    createdAt: new Date().toISOString(),
    games: 0,
    wins: 0,
    points: 0,
    murdererEscapes: 0,
    casesSolved: 0,
    bonusCompleted: 0,
    bestRole: "Rookie"
  };
  saveProfiles();
  return playerProfiles[id];
}

function fallbackProfile(name) {
  const cleanName = sanitizeName(name || "Player");
  const key = `LOCAL-${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 16) || "anonymous"}`;
  if (!playerProfiles[key]) {
    playerProfiles[key] = {
      id: key,
      name: cleanName,
      createdAt: new Date().toISOString(),
      games: 0,
      wins: 0,
      points: 0,
      murdererEscapes: 0,
      casesSolved: 0,
      bonusCompleted: 0,
      bestRole: "Rookie"
    };
    saveProfiles();
  }
  return playerProfiles[key];
}

function ensureProfile(profileIdOrName) {
  const code = normalizeProfileCode(profileIdOrName);
  if (code && playerProfiles[code]) return playerProfiles[code];
  if (profileIdOrName && playerProfiles[profileIdOrName]) return playerProfiles[profileIdOrName];
  return fallbackProfile(profileIdOrName);
}

function getProfileStats(profileIdOrName) {
  const profile = ensureProfile(profileIdOrName);
  const winRate = profile.games ? Math.round((profile.wins / profile.games) * 100) : 0;
  const title = profile.points >= 2500 ? "Legend Detective"
    : profile.points >= 1500 ? "Master Investigator"
    : profile.points >= 800 ? "Senior Detective"
    : profile.points >= 400 ? "Sharp Witness"
    : profile.points >= 150 ? "Trusted Player"
    : "Rookie";
  profile.bestRole = title;
  return { ...profile, winRate, title, profileCode: profile.id };
}

function updatePlayerProfiles(room, detectiveSuccess) {
  room.players.forEach((p) => {
    const profile = ensureProfile(p.profileId || p.name);
    const isMurdererSide = p.role === "Murderer" || p.role === "Accomplice";
    const won = isMurdererSide ? !detectiveSuccess : detectiveSuccess;
    const bonus = Boolean(p.bonusCompleted);
    const points = (p.lastGained || 0) + (bonus ? 35 : 0) + (won ? 15 : 0);

    profile.name = sanitizeName(p.name || profile.name);
    profile.games += 1;
    profile.points += points;
    if (won) profile.wins += 1;
    if (bonus) profile.bonusCompleted += 1;
    if (p.role === "Murderer" && !detectiveSuccess) profile.murdererEscapes += 1;
    if (!isMurdererSide && detectiveSuccess) profile.casesSolved += 1;

    p.profileId = profile.id;
    p.profileStats = getProfileStats(profile.id);
    p.profilePointsGained = points;
  });
  saveProfiles();
}

function profileLeaderboard() {
  return Object.values(playerProfiles)
    .filter((p) => p && !String(p.id || "").startsWith("LOCAL-") || (p.games || 0) > 0)
    .map((p) => ({ ...getProfileStats(p.id) }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);
}

function publicPlayers(players) {
  return players.map((p) => ({
    id: p.id,
    name: p.name,
    suspicion: p.suspicion || 0,
    score: p.score || 0,
    profileStats: getProfileStats(p.profileId || p.name),
    publicAlibi: p.publicAlibi || "No alibi yet."
  }));
}

function emitRoomUpdate(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  io.to(roomId).emit("roomUpdate", {
    players: publicPlayers(room.players),
    viewerVotes: voteSummary(room),
    playerVotes: playerVoteSummary(room),
    leaderboard: profileLeaderboard(),
    activeStreamEvent: room.activeStreamEvent,
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