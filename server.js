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
const HOST_PROFILE_FILE = path.join(__dirname, "host_profiles.json");
const FEEDBACK_FILE = path.join(__dirname, "feedback.json");
const ANALYTICS_FILE = path.join(__dirname, "analytics.json");
const playerProfiles = loadProfiles();
const hostProfiles = loadHostProfiles();
const communityFeedback = loadJsonArray(FEEDBACK_FILE);
const analytics = loadAnalytics();

const DEFAULT_SETTINGS = {
  minPlayers: 2,
  maxPlayers: 10,
  roundTime: 210,
  cooldown: 4000,
  difficulty: "normal"
};

io.on("connection", (socket) => {

  socket.on("createHostProfile", ({ name, channel }) => {
    const profile = createHostProfile(name || channel || "Detective", channel || "");
    socket.emit("hostProfileCreated", {
      profileCode: profile.id,
      profile: getHostProfileStats(profile.id)
    });
  });

  socket.on("loadHostProfile", ({ profileCode }) => {
    const code = normalizeHostProfileCode(profileCode);
    const profile = code ? hostProfiles[code] : null;

    if (!profile) {
      socket.emit("hostProfileError", "Host Profile not found. Check the Detective ID or create a new host profile.");
      return;
    }

    socket.emit("hostProfileLoaded", {
      profileCode: profile.id,
      profile: getHostProfileStats(profile.id)
    });
  });

  socket.on("renameHostProfile", ({ profileCode, name, channel }) => {
    const code = normalizeHostProfileCode(profileCode);
    const profile = code ? hostProfiles[code] : null;

    if (!profile) {
      socket.emit("hostProfileError", "Host Profile not found.");
      return;
    }

    profile.name = sanitizeName(name || profile.name);
    profile.channel = sanitizeMessage(channel || profile.channel || "");
    saveHostProfiles();

    socket.emit("hostProfileLoaded", {
      profileCode: profile.id,
      profile: getHostProfileStats(profile.id)
    });
  });

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

  socket.on("submitFeedback", ({ type, message, name, roomId, profileCode }) => {
    const cleanMessage = sanitizeLongText(message || "");
    if (!cleanMessage) {
      socket.emit("feedbackError", "Write a short message first.");
      return;
    }

    const item = {
      id: `FB-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      date: new Date().toISOString(),
      type: sanitizeFeedbackType(type),
      name: sanitizeName(name || "Anonymous"),
      roomId: roomId ? String(roomId).trim().toUpperCase().slice(0, 12) : "",
      profileCode: normalizeProfileCode(profileCode) || "",
      message: cleanMessage
    };

    communityFeedback.unshift(item);
    while (communityFeedback.length > 300) communityFeedback.pop();
    saveJson(FEEDBACK_FILE, communityFeedback);

    analytics.feedbackSubmitted = (analytics.feedbackSubmitted || 0) + 1;
    analytics.lastFeedbackAt = item.date;
    saveAnalytics();

    socket.emit("feedbackThanks", { message: "Thanks — your feedback was saved." });
  });

  socket.on("requestPatchNotes", () => {
    socket.emit("patchNotes", getPatchNotes());
  });

  socket.on("joinRoom", ({ roomId, role, name, hostKey, profileCode, hostProfileCode }) => {
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

      const hostCode = normalizeHostProfileCode(hostProfileCode);
      const hostProfile = hostCode ? hostProfiles[hostCode] : null;

      room.streamer = socket.id;
      room.hostProfileId = hostProfile ? hostProfile.id : room.hostProfileId || null;
      room.streamerName = sanitizeName(name || (hostProfile ? hostProfile.name : "Streamer"));

      if (hostProfile) {
        socket.emit("hostProfileLinked", {
          profileCode: hostProfile.id,
          profile: getHostProfileStats(hostProfile.id)
        });
      }

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
    room.murdererTools = {};
    analytics.gamesStarted = (analytics.gamesStarted || 0) + 1;
    analytics.lastGameStartedAt = new Date().toISOString();
    saveAnalytics();
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
        relationship: p.relationship,
        motive: p.motive,
        evidenceFragment: p.evidenceFragment,
        interrogationAngle: p.interrogationAngle,
        abilityName: p.abilityName,
        abilityDescription: p.abilityDescription,
        canUseAnonymous: true,
        caseFile: room.caseFile,
        profileCode: p.profileId,
        profileStats: getProfileStats(p.profileId || p.name),
        murdererTools: p.role === "Murderer" ? getMurdererTools(room) : []
      });

      io.to(p.id).emit("roundState", {
        state: "playing",
        roundNumber: room.roundNumber
      });
    });

    io.to(roomId).emit("roundStarted", {
      caseFile: room.caseFile,
      caseDepth: room.caseDepth,
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

  socket.on("murdererTool", ({ roomId, type, targetId }) => {
    roomId = String(roomId || "").trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.role !== "Murderer") {
      socket.emit("systemMessage", "Only the murderer can use sabotage tools.");
      return;
    }

    applyMurdererTool(roomId, room, player, type, targetId);
  });

  socket.on("adjustSuspicion", ({ roomId, playerId, amount }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.streamer) return;

    const player = room.players.find((p) => p.id === playerId);
    if (!player) return;

    player.suspicion = Math.max(0, Math.min(100, player.suspicion + amount));

    io.to(roomId).emit("suspicionUpdate", {
      players: publicPlayers(room.players),
      detectiveDirector: generateDetectiveDirector(room),
      caseIntensity: calculateCaseIntensity(room)
    });
    emitDirectorUpdate(roomId);
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
    updateHostProfile(room, success);
    recordGameAnalytics(room, success);

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
    emitDirectorUpdate(roomId);
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
    emitDirectorUpdate(roomId);
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
    emitDirectorUpdate(roomId);
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
    emitDirectorUpdate(roomId);
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
    emitDirectorUpdate(roomId);
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
    emitDirectorUpdate(roomId);
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
    hostProfileId: null,
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
    murdererTools: {},
    sabotageLog: [],
    directorHistory: [],
    caseIntensity: 0,
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

function getMurdererTools(room) {
  const used = room.murdererTools || {};
  return [
    { type: "frame", label: "Frame Player", icon: "🎭", needsTarget: true, used: !!used.frame, description: "Add suspicion to another player and create a vague investigation distortion." },
    { type: "corrupt", label: "Corrupt Evidence", icon: "🧩", needsTarget: false, used: !!used.corrupt, description: "Turn one board lead into corrupted evidence." },
    { type: "falseLead", label: "False Lead", icon: "📨", needsTarget: false, used: !!used.falseLead, description: "Inject a misleading anonymous report." },
    { type: "blur", label: "Blur Lead", icon: "🌫️", needsTarget: false, used: !!used.blur, description: "Make one investigation lead less clear." },
    { type: "twistRelation", label: "Twist Relationship", icon: "🤝", needsTarget: true, used: !!used.twistRelation, description: "Make a player's relationship angle sound suspicious." }
  ];
}

function applyMurdererTool(roomId, room, murderer, type, targetId) {
  if (!room.murdererTools) room.murdererTools = {};
  if (!room.sabotageLog) room.sabotageLog = [];

  const tool = getMurdererTools(room).find((t) => t.type === type);
  if (!tool) {
    io.to(murderer.id).emit("systemMessage", "Unknown sabotage tool.");
    return;
  }

  if (room.murdererTools[type]) {
    io.to(murderer.id).emit("systemMessage", "You already used that sabotage tool this round.");
    return;
  }

  const target = targetId ? room.players.find((p) => p.id === targetId) : null;
  if (tool.needsTarget && !target) {
    io.to(murderer.id).emit("systemMessage", "Choose a target first.");
    return;
  }

  room.murdererTools[type] = true;
  const log = {
    type,
    title: tool.label,
    targetName: target ? target.name : "Investigation Board",
    time: new Date().toLocaleTimeString()
  };
  room.sabotageLog.unshift(log);

  if (type === "frame") {
    target.suspicion = Math.min(100, (target.suspicion || 0) + 18);
    emitInvestigationDistortion(roomId, "🎭 Investigation Distortion", `A vague lead suddenly makes ${target.name}'s alibi look worse.`);
    io.to(roomId).emit("suspicionUpdate", {
      players: publicPlayers(room.players),
      detectiveDirector: generateDetectiveDirector(room),
      caseIntensity: calculateCaseIntensity(room)
    });
  }

  if (type === "corrupt") {
    const evidence = random((room.evidence || []).filter((e) => e.reliability !== "Corrupted")) || (room.evidence || [])[0];
    if (evidence) {
      evidence.reliability = "Corrupted";
      evidence.type = "Corrupted Lead";
      evidence.text = `A recovered record is now unreadable. It supports theories, but cannot confirm who caused the incident.`;
      io.to(roomId).emit("evidenceCorrupted", evidence);
    }
    emitInvestigationDistortion(roomId, "🧩 Corrupted Log", "A section of the investigation record became unreliable.");
  }

  if (type === "falseLead") {
    io.to(roomId).emit("newMessage", {
      playerId: "sabotageFalseLead",
      name: "Anonymous Report",
      message: generateFalseLead(room, murderer),
      tag: "REPORT",
      time: new Date().toLocaleTimeString()
    });
    emitInvestigationDistortion(roomId, "📨 Anonymous Report", "A new witness claim entered the room. Its reliability is unknown.");
  }

  if (type === "blur") {
    const evidence = random(room.evidence || []);
    if (evidence) {
      evidence.reliability = "Questionable";
      evidence.text = `The lead is too incomplete to identify anyone directly. Players must compare alibis instead.`;
      io.to(roomId).emit("evidenceCorrupted", evidence);
    }
    emitInvestigationDistortion(roomId, "🌫️ Lead Blurred", "One clue became less clear. The room must rely on statements and contradictions.");
  }

  if (type === "twistRelation") {
    target.relationship = `A new rumor suggests ${target.name}'s earlier connection may not be as innocent as it sounded.`;
    target.interrogationAngle = `Ask ${target.name} why their relationship angle changed after pressure entered the room.`;
    emitInvestigationDistortion(roomId, "🤝 Relationship Rumor", `${target.name}'s connection to the case now looks more suspicious.`);
  }

  analytics.sabotageUsed = (analytics.sabotageUsed || 0) + 1;
  saveAnalytics();

  io.to(murderer.id).emit("murdererToolUsed", { type, tools: getMurdererTools(room) });
  io.to(roomId).emit("systemMessage", "🚨 Investigation distortion detected. Not all new information may be reliable.");
  io.to(roomId).emit("soundCue", "twist");
  emitDirectorUpdate(roomId);
  emitRoomUpdate(roomId);
}

function emitInvestigationDistortion(roomId, title, message) {
  const event = {
    type: "sabotage",
    icon: "🚨",
    title,
    message,
    seconds: 12
  };
  io.to(roomId).emit("streamEvent", event);
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

  const motiveThemes = [
    "Reputation damage",
    "Access to restricted information",
    "Covering a previous mistake",
    "Protecting someone else",
    "Fear of being blamed",
    "Control over a valuable object"
  ];

  const suspiciousObjects = [
    room.incident.object,
    "an unsigned access note",
    "a corrupted security log",
    "a misplaced keycard",
    "a broken headset",
    "a half-deleted message"
  ];

  const conflictingDetail = random([
    `One person remembers movement near ${room.incident.location}, but the timing is unclear.`,
    `Two alibis may overlap around ${room.incident.time}.`,
    `A witness heard footsteps, but cannot identify the direction.`,
    `A system log confirms activity, but not the person responsible.`,
    `Someone had a reason to hide where they really were.`
  ]);

  return {
    number: caseNumber,
    title: `CASE #${caseNumber}: ${room.incident.title}`,
    location: room.incident.location,
    incident: room.incident.incident,
    time: room.incident.time,
    atmosphere: room.incident.atmosphere + (room.incident.difficultyNote || ""),
    motiveTheme: random(motiveThemes),
    suspiciousObject: random(suspiciousObjects),
    conflictingDetail,
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
  murderer.abilityDescription = "Use your normal ability, then use your hidden sabotage toolkit carefully. Each sabotage tool can be used once per round.";
  murderer.bonusObjective = random([
    `Bonus: Make ${frameTarget.name} become Prime Suspect before reveal.`,
    `Bonus: Cause two players to argue about their alibis.`,
    `Bonus: Keep your suspicion below 50% until the final accusation.`,
    `Bonus: Make the detective accuse an innocent player.`
  ]);
  murderer.bonusTargetId = frameTarget.id;
  murderer.bonusTargetName = frameTarget.name;
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

  assignDepthIntel(room, murderer, frameTarget, locations);
  assignBonusObjectives(room, murderer, frameTarget);
}

function assignDepthIntel(room, murderer, frameTarget, locations) {
  const publicFragmentRules = {
    Witness: [
      "Photo Fragment: a blurred figure appears near the incident route, but the face is not visible.",
      "Witness Statement: you saw someone leave quickly, but only remember their posture, not their identity.",
      "Route Note: someone crossed near the case location shortly before the incident, but the direction is unclear.",
      "Audio Fragment: you heard hurried footsteps and a short metallic sound near the incident time."
    ],
    Guard: [
      "Guard Log: one checkpoint was skipped, but the log does not name who skipped it.",
      "Patrol Note: a corridor door was opened near the incident window, but the camera angle failed.",
      "Security Fragment: someone had access nearby, but access does not prove guilt.",
      "Badge Trace: a reader pinged once, but the record is partial."
    ],
    Journalist: [
      "Interview Fragment: someone sounded defensive when asked about access permissions.",
      "Rumor Note: two people disagreed earlier, but the argument may be unrelated.",
      "Report Draft: one alibi sounds rehearsed, but there is no proof it is fake.",
      "Voice Note: someone mentioned the missing object before the incident became public."
    ],
    Informant: [
      "Access Log: a partial entry confirms movement, but the name field is corrupted.",
      "Anonymous Source: someone was hiding a harmless mistake that now looks suspicious.",
      "Message Fragment: one deleted line mentions timing, but not the culprit.",
      "Tip Fragment: the strongest clue points to a route, not a person."
    ],
    Analyst: [
      "Timeline Fragment: two stories overlap in a way that needs questioning.",
      "System Fragment: the incident window is narrower than people think, but still not solved.",
      "Pattern Note: one player gave details too late, after hearing other alibis.",
      "Data Fragment: a route conflict exists, but it could be panic, mistake, or guilt."
    ],
    Lawyer: [
      "Defense Note: one suspicious player may be innocent because their motive has another explanation.",
      "Statement Fragment: a nervous answer does not automatically mean guilt.",
      "Alibi Note: someone has a weak confirmation, not a broken alibi.",
      "Context Fragment: one accusation may be moving too fast."
    ],
    Drifter: [
      "Route Fragment: your path crossed several rooms, which makes your own story messy.",
      "Movement Note: you saw motion near a side route, but cannot place it exactly.",
      "Memory Fragment: you remember noise, not identity.",
      "Timing Fragment: your movement could confuse the case if explained badly."
    ],
    Observer: [
      "Observation Fragment: someone acted nervous, but that could be fear, not guilt.",
      "Room Tone: the group became quiet when the case location was mentioned.",
      "Behavior Note: one player changed wording after hearing another alibi.",
      "Soft Clue: you noticed pressure building around the wrong detail."
    ]
  };

  const relationshipReasons = [
    (p, t) => `You trust ${t.name} because they helped you cover a minor mistake earlier. That trust may make you biased.`,
    (p, t) => `You argued with ${t.name} about access permissions before the incident. It may sound worse than it was.`,
    (p, t) => `You expected to meet ${t.name}, but they arrived late. Ask them why before accusing them.`,
    (p, t) => `${t.name} can partly confirm your route, but only for one part of the timeline.`,
    (p, t) => `You saw ${t.name} near a side route, but that does not prove they entered ${room.incident.location}.`,
    (p, t) => `You think ${t.name} is hiding an embarrassing mistake, not necessarily the crime.`,
    (p, t) => `${t.name} warned you not to mention something small. That now feels suspicious.`,
    (p, t) => `You and ${t.name} both noticed the same sound, but disagree on where it came from.`
  ];

  const motiveTemplates = [
    `You broke a small rule earlier and do not want the detective to focus on it.`,
    `You had a harmless reason to be near ${room.incident.location}, but explaining it may sound suspicious.`,
    `You were protecting someone else's privacy, even though it could make you look guilty.`,
    `You needed information connected to ${room.incident.object}, but not for the crime.`,
    `You panicked after the incident and your timeline may sound less clean than it is.`,
    `You know a useful detail, but revealing it too early could put suspicion on you.`,
    `You lied about one small thing before the case started. The lie is not the crime, but it can hurt you.`,
    `You were trying to avoid blame for a separate mistake. That motive can be misunderstood.`
  ];

  room.players.forEach((p) => {
    const candidates = room.players.filter((x) => x.id !== p.id);
    const target = random(candidates) || p;
    const nearby = random(locations.filter((l) => l !== room.incident.location)) || "a side corridor";

    p.relationshipTargetId = target.id;
    p.relationshipTargetName = target.name;
    p.relationship = random(relationshipReasons)(p, target);
    p.motive = random(motiveTemplates);

    if (p.role === "Murderer") {
      const frameName = frameTarget?.name || target.name;
      p.relationship = `You need ${frameName} to look more suspicious than you without making it obvious.`;
      p.motive = `Your real motive is tied to ${room.incident.object}. Keep the room focused on imperfect alibis instead of motive.`;
      p.evidenceFragment = random([
        `False Fragment: you can claim you noticed movement near ${nearby}, but keep the description vague.`,
        `Fake Route Note: you can imply someone crossed near ${nearby}, but do not give too many details.`,
        `Corrupted Memory: you can pretend your timing is fuzzy to avoid being pinned down.`,
        `False Behavior Note: you can say ${frameName} seemed nervous after the incident.`
      ]);
      p.interrogationAngle = `If questioned, redirect toward ${frameName}'s timing gap and avoid giving exact minutes.`;
      return;
    }

    if (p.role === "Accomplice") {
      p.relationship = `You know ${murderer.name} is connected to the incident. Protect them without sounding coordinated.`;
      p.motive = `You are protecting someone because exposing them may expose your own bad decision too.`;
      p.evidenceFragment = random([
        `Cover Fragment: one detail can make ${murderer.name}'s route sound less suspicious, but overusing it will expose you.`,
        `Support Note: you can soften one accusation, but do not defend too aggressively.`,
        `Timing Fragment: you know a tiny detail that can blur the incident window.`
      ]);
      p.interrogationAngle = `Defend without over-defending. If pressured, talk about uncertainty, not certainty.`;
      return;
    }

    const list = publicFragmentRules[p.role] || publicFragmentRules.Observer;
    p.evidenceFragment = random(list);
    p.interrogationAngle = random([
      `Ask who can confirm your route before revealing too much.`,
      `Use your relationship detail to challenge another player's timeline.`,
      `Do not oversell your evidence. It is a fragment, not proof.`,
      `Your motive can make you look suspicious, so explain it before someone twists it.`,
      `Push others to explain what they were doing, not just where they were.`,
      `Reveal your fragment only when it helps compare two alibis.`
    ]);
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
      text: `The incident happened around ${room.incident.time}. The exact movement order is still uncertain.`
    },
    {
      type: "Fragment Rule",
      reliability: "Stable",
      text: `No single clue identifies the culprit. Evidence fragments must be compared with alibis, motives, and relationships.`
    },
    {
      type: "Open Lead",
      reliability: "Questionable",
      text: `Someone moved near the incident route, but identity and intent are unclear.`
    },
    {
      type: "Relationship Lead",
      reliability: "Questionable",
      text: `At least two players have a personal connection that could create bias, protection, or false suspicion.`
    },
    {
      type: "Motive Theme",
      reliability: "Questionable",
      text: `Possible motive theme: ${room.caseFile?.motiveTheme || "unknown pressure"}. Innocent players may still look guilty.`
    },
    {
      type: "Suspicious Object",
      reliability: "Questionable",
      text: `Investigators found mention of ${room.caseFile?.suspiciousObject || "a suspicious object"}. It may be evidence, bait, or a coincidence.`
    },
    {
      type: "Corrupted Record",
      reliability: "Corrupted",
      text: `System records are incomplete. Treat logs as support, not proof.`
    }
  ];
}
function generateMidEvidence(room) {
  return random([
    {
      type: "Recovered Movement Fragment",
      reliability: "Questionable",
      text: `Recovered footage shows movement near a route connected to ${room.incident.location}. Identity unclear.`
    },
    {
      type: "Audio Fragment",
      reliability: "Questionable",
      text: `A short audio fragment captured hurried movement and a metallic sound, but no clear voice.`
    },
    {
      type: "Partial Access Log",
      reliability: "Corrupted",
      text: `One access entry is damaged. It confirms activity, not the person responsible.`
    },
    {
      type: "Witness Correction",
      reliability: "Questionable",
      text: `A witness corrected their memory: the direction of movement may have been wrong.`
    },
    {
      type: "Motive Lead",
      reliability: "Questionable",
      text: `Someone had a reason to hide a separate mistake. That does not automatically make them guilty.`
    },
    {
      type: "Relationship Lead",
      reliability: "Questionable",
      text: `One player may be protecting another player, but the reason is unclear.`
    }
  ]);
}
function generateSuggestedQuestions(room) {
  const base = [
    `Where were you at ${room.incident.time}?`,
    `What exactly were you doing there?`,
    `Who can confirm only part of your alibi?`,
    `What motive might make you look suspicious even if you are innocent?`,
    `Who are you protecting, trusting, or avoiding?`,
    `What evidence fragment do you have: photo, audio, log, route, or witness statement?`,
    `Which clue creates a question instead of an answer?`,
    `Who sounds too certain for a weak fragment?`
  ];

  const contextual = room.players
    .filter((p) => p.relationship || p.motive || p.evidenceFragment)
    .slice(0, 8)
    .map((p) => random([
      `${p.name} has a personal angle. Ask what they are afraid will be misunderstood.`,
      `${p.name} has a connection to ${p.relationshipTargetName || "another player"}. Ask why that connection matters.`,
      `${p.name} has an evidence fragment. Ask what it proves and what it does NOT prove.`,
      `Ask ${p.name} whether their motive is guilt, panic, or protection.`,
      `Ask ${p.name} who benefits if their fragment is interpreted the wrong way.`
    ]));

  return [...base, ...contextual];
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
    viewerVotes: voteSummary(room),
    detectiveDirector: generateDetectiveDirector(room),
    caseIntensity: calculateCaseIntensity(room)
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
  io.to(roomId).emit("suspicionUpdate", { players: publicPlayers(room.players), detectiveDirector: generateDetectiveDirector(room), caseIntensity: calculateCaseIntensity(room) });
  emitDirectorUpdate(roomId);
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




function loadHostProfiles() {
  try {
    if (!fs.existsSync(HOST_PROFILE_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(HOST_PROFILE_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch (err) {
    console.warn("Could not load host_profiles.json:", err.message);
    return {};
  }
}

function saveHostProfiles() {
  try {
    fs.writeFileSync(HOST_PROFILE_FILE, JSON.stringify(hostProfiles, null, 2));
  } catch (err) {
    console.warn("Could not save host_profiles.json:", err.message);
  }
}

function normalizeHostProfileCode(code) {
  if (!code || typeof code !== "string") return "";
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{3})(.{4})(.{4})$/, "$1-$2-$3");
}

function generateHostProfileCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let raw = "";
  do {
    raw = "HST" + Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (hostProfiles[`${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7)}`]);
  return `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7)}`;
}

function createHostProfile(name, channel = "") {
  const id = generateHostProfileCode();
  hostProfiles[id] = {
    id,
    name: sanitizeName(name || "Detective"),
    channel: sanitizeMessage(channel || ""),
    createdAt: new Date().toISOString(),
    casesHosted: 0,
    casesSolved: 0,
    murdererEscapes: 0,
    totalPlayers: 0,
    bestLobby: 0,
    communityPoints: 0,
    emergencyEventsUsed: 0
  };
  saveHostProfiles();
  return hostProfiles[id];
}

function ensureHostProfile(profileIdOrName) {
  const code = normalizeHostProfileCode(profileIdOrName);
  if (code && hostProfiles[code]) return hostProfiles[code];
  if (profileIdOrName && hostProfiles[profileIdOrName]) return hostProfiles[profileIdOrName];
  return null;
}

function getHostProfileStats(profileId) {
  const profile = ensureHostProfile(profileId);
  if (!profile) return null;
  const successRate = profile.casesHosted ? Math.round((profile.casesSolved / profile.casesHosted) * 100) : 0;
  const avgPlayers = profile.casesHosted ? Math.round((profile.totalPlayers / profile.casesHosted) * 10) / 10 : 0;
  const rank = profile.communityPoints >= 3000 ? "Legend Detective"
    : profile.communityPoints >= 1800 ? "Master Detective"
    : profile.communityPoints >= 1000 ? "Chief Inspector"
    : profile.communityPoints >= 500 ? "Inspector"
    : profile.communityPoints >= 150 ? "Investigator"
    : "Cadet Detective";
  return { ...profile, successRate, avgPlayers, rank, profileCode: profile.id };
}

function updateHostProfile(room, detectiveSuccess) {
  if (!room.hostProfileId) return;
  const profile = ensureHostProfile(room.hostProfileId);
  if (!profile) return;

  profile.name = sanitizeName(room.streamerName || profile.name);
  profile.casesHosted += 1;
  profile.totalPlayers += room.players.length;
  profile.bestLobby = Math.max(profile.bestLobby || 0, room.players.length);
  if (detectiveSuccess) profile.casesSolved += 1;
  else profile.murdererEscapes += 1;

  const eventBonus = room.activeStreamEvent ? 10 : 0;
  const playerBonus = Math.min(40, room.players.length * 3);
  profile.communityPoints += 50 + (detectiveSuccess ? 30 : 10) + playerBonus + eventBonus;

  saveHostProfiles();
}

function hostProfileLeaderboard() {
  return Object.values(hostProfiles)
    .map((p) => getHostProfileStats(p.id))
    .filter(Boolean)
    .sort((a, b) => b.communityPoints - a.communityPoints)
    .slice(0, 10);
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

function calculateCaseIntensity(room) {
  if (!room) return { score: 0, label: "Calm", reasons: [] };

  const reasons = [];
  let score = 0;

  const contradictionCount = (room.contradictions || []).length;
  if (contradictionCount) {
    score += Math.min(30, contradictionCount * 10);
    reasons.push(`${contradictionCount} contradiction${contradictionCount === 1 ? "" : "s"}`);
  }

  const topSuspicion = Math.max(0, ...room.players.map((p) => p.suspicion || 0));
  if (topSuspicion >= 20) {
    score += Math.min(30, Math.floor(topSuspicion / 2));
    reasons.push(`top suspicion ${topSuspicion}%`);
  }

  const viewerVotes = Object.keys(room.viewerVotes || {}).length;
  const playerVotes = Object.keys(room.playerVotes || {}).length;
  if (viewerVotes || playerVotes) {
    score += Math.min(20, viewerVotes * 2 + playerVotes * 4);
    reasons.push(`${viewerVotes + playerVotes} vote${viewerVotes + playerVotes === 1 ? "" : "s"}`);
  }

  if (room.activeStreamEvent) {
    score += 15;
    reasons.push(room.activeStreamEvent.title || "stream event");
  }

  if (room.spotlightPlayerId) {
    score += 10;
    reasons.push("spotlight active");
  }

  if (room.timeLeft && room.settings && room.settings.roundTime > 0 && room.timeLeft <= 30) {
    score += 15;
    reasons.push("final seconds");
  }

  score = Math.max(0, Math.min(100, score));
  const label = score >= 75 ? "Chaotic" : score >= 50 ? "Heated" : score >= 25 ? "Tense" : "Calm";
  return { score, label, reasons: reasons.slice(0, 3) };
}

function generateDetectiveDirector(room) {
  if (!room || !room.players) {
    return [{ type: "info", title: "Waiting", text: "Start a round to receive detective suggestions.", action: "Start Round" }];
  }

  const suggestions = [];
  const players = room.players || [];
  const topSuspect = [...players].sort((a, b) => (b.suspicion || 0) - (a.suspicion || 0))[0];
  const viewerTop = voteSummary(room).find((v) => v.votes > 0);
  const playerVoteTop = playerVoteSummary(room).find((v) => v.votes > 0);
  const contradiction = (room.contradictions || [])[0];

  if (contradiction) {
    suggestions.push({
      type: "danger",
      title: "Question contradiction",
      text: `${contradiction.playerName} has a location conflict: ${contradiction.earlierLocation} → ${contradiction.currentLocation}.`,
      action: `Ask ${contradiction.playerName} to explain the timeline.`
    });
  }

  if (viewerTop && viewerTop.percent >= 35) {
    suggestions.push({
      type: "vote",
      title: "Audience pressure",
      text: `Viewers are focusing on ${viewerTop.name} with ${viewerTop.percent}% of votes.`,
      action: `Spotlight or directly question ${viewerTop.name}.`
    });
  }

  if (playerVoteTop && playerVoteTop.percent >= 35) {
    suggestions.push({
      type: "vote",
      title: "Player vote pressure",
      text: `Players are leaning toward ${playerVoteTop.name} with ${playerVoteTop.percent}% of emergency votes.`,
      action: `Ask voters why they chose ${playerVoteTop.name}.`
    });
  }

  const relationshipTarget = players.find((p) => p.relationshipTargetName && (p.suspicion || 0) < 70);
  if (relationshipTarget) {
    suggestions.push({
      type: "relationship",
      title: "Relationship angle",
      text: `${relationshipTarget.name} has a connection involving ${relationshipTarget.relationshipTargetName}.`,
      action: `Ask ${relationshipTarget.name}: why does that connection matter?`
    });
  }

  const motiveTarget = players.find((p) => p.motive && (p.suspicion || 0) >= 20) || players.find((p) => p.motive);
  if (motiveTarget) {
    suggestions.push({
      type: "motive",
      title: "Motive check",
      text: `${motiveTarget.name} has a personal motive that may make them look suspicious.`,
      action: `Ask if the motive is guilt or just panic.`
    });
  }

  const evidenceHolder = players.find((p) => p.evidenceFragment && !p.revealedClue);
  if (evidenceHolder) {
    suggestions.push({
      type: "evidence",
      title: "Evidence fragment",
      text: `${evidenceHolder.name} is holding a fragment that may help the case.`,
      action: `Ask ${evidenceHolder.name} what type of fragment they have, not who it proves.`
    });
  }

  if (topSuspect && (topSuspect.suspicion || 0) >= 50) {
    suggestions.push({
      type: "suspect",
      title: "High suspicion",
      text: `${topSuspect.name} is at ${topSuspect.suspicion}% suspicion.`,
      action: `Either pressure ${topSuspect.name} or ask who can confirm their alibi.`
    });
  }

  if (!room.activeStreamEvent && suggestions.length < 3 && room.state === "playing") {
    suggestions.push({
      type: "pace",
      title: "Keep the round moving",
      text: "If the room becomes quiet, use a Stream Event instead of waiting.",
      action: "Use Force Alibis or Drop New Lead."
    });
  }

  if ((room.sabotageLog || []).length) {
    const lastSabotage = room.sabotageLog[0];
    suggestions.push({
      type: "danger",
      title: "Information may be distorted",
      text: `${lastSabotage.title} affected ${lastSabotage.targetName}.`,
      action: "Ask players to explain, but do not fully trust the newest lead."
    });
  }

  if (!suggestions.length) {
    suggestions.push({
      type: "info",
      title: "Start with alibis",
      text: "Begin by asking every player where they were and who can confirm it.",
      action: "Ask the first player for their route."
    });
  }

  return suggestions.slice(0, 5);
}

function emitDirectorUpdate(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit("directorUpdate", {
    detectiveDirector: generateDetectiveDirector(room),
    caseIntensity: calculateCaseIntensity(room)
  });
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
    hostProfileStats: room.hostProfileId ? getHostProfileStats(room.hostProfileId) : null,
    hostLeaderboard: hostProfileLeaderboard(),
    activeStreamEvent: room.activeStreamEvent,
    detectiveDirector: generateDetectiveDirector(room),
    caseIntensity: calculateCaseIntensity(room),
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


function sanitizeFeedbackType(type) {
  const allowed = ["Bug", "Feature", "UI", "Balance", "General"];
  const clean = String(type || "General").trim();
  return allowed.includes(clean) ? clean : "General";
}

function sanitizeLongText(message) {
  if (!message || typeof message !== "string") return "";
  return message.trim().slice(0, 1000);
}

function loadJsonArray(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to save ${file}:`, err.message);
  }
}

function loadAnalytics() {
  try {
    if (!fs.existsSync(ANALYTICS_FILE)) {
      return {
        gamesStarted: 0,
        gamesFinished: 0,
        murdererWins: 0,
        detectiveWins: 0,
        sabotageUsed: 0,
        feedbackSubmitted: 0,
        totalPlayersAcrossGames: 0,
        roleCounts: {},
        abilityUse: {}
      };
    }
    return JSON.parse(fs.readFileSync(ANALYTICS_FILE, "utf8"));
  } catch {
    return { gamesStarted: 0, gamesFinished: 0, murdererWins: 0, detectiveWins: 0, sabotageUsed: 0, feedbackSubmitted: 0, totalPlayersAcrossGames: 0, roleCounts: {}, abilityUse: {} };
  }
}

function saveAnalytics() {
  saveJson(ANALYTICS_FILE, analytics);
}

function recordGameAnalytics(room, detectiveSolved) {
  analytics.gamesFinished = (analytics.gamesFinished || 0) + 1;
  if (detectiveSolved) analytics.detectiveWins = (analytics.detectiveWins || 0) + 1;
  else analytics.murdererWins = (analytics.murdererWins || 0) + 1;
  analytics.totalPlayersAcrossGames = (analytics.totalPlayersAcrossGames || 0) + (room.players || []).length;
  analytics.lastGameFinishedAt = new Date().toISOString();
  analytics.roleCounts = analytics.roleCounts || {};
  (room.players || []).forEach((p) => {
    analytics.roleCounts[p.role] = (analytics.roleCounts[p.role] || 0) + 1;
  });
  saveAnalytics();
}

function getPatchNotes() {
  return [
    { version: "Pre-launch 14C", title: "Advanced Murderer Tools", items: ["Frame Player", "Corrupt Evidence", "Anonymous False Lead", "Blur Lead", "Relationship Rumor"] },
    { version: "Pre-launch 14D", title: "Community Feedback", items: ["Feedback center", "Bug reports", "Feature suggestions", "Patch notes", "Lightweight launch analytics"] },
    { version: "Pre-launch 14B", title: "Evidence Overhaul", items: ["Relationship reasons", "Motives", "Evidence fragments", "Better Director prompts"] }
  ];
}

const PORT = process.env.PORT || process.env.HOSTINGER_PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Running on port ${PORT}`);
});