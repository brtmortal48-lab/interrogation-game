const socket = io();

let adminAuth = { username: "", password: "" };
let adminFeedback = [];
let adminAnalytics = {};

function loginAdmin() {
  const username = document.getElementById("adminUsername").value.trim();
  const password = document.getElementById("adminPassword").value;

  if (!username || !password) {
    showAdminStatus("Enter username and password.");
    return;
  }

  adminAuth = { username, password };
  showAdminStatus("Checking login...");
  socket.emit("requestAdminData", adminAuth);
}

function refreshAdmin() {
  socket.emit("requestAdminData", adminAuth);
}

socket.on("adminError", (message) => {
  showAdminStatus(message || "Admin login failed.");
});

socket.on("adminData", (data) => {
  document.getElementById("adminLogin").style.display = "none";
  document.getElementById("adminDashboard").style.display = "block";

  adminFeedback = data.feedback || [];
  adminAnalytics = data.analytics || {};

  renderAnalytics(adminAnalytics);
  renderFeedback();
  renderPatchNotes(data.patchNotes || []);
});

function showAdminStatus(message) {
  const el = document.getElementById("adminLoginStatus");
  el.innerText = message;
  el.style.display = "block";
}

function renderAnalytics(a) {
  setText("statGamesStarted", a.gamesStarted || 0);
  setText("statGamesFinished", a.gamesFinished || 0);
  setText("statSuccessRate", `${a.successRate || 0}%`);
  setText("statMurdererRate", `${a.murdererWinRate || 0}%`);
  setText("statAvgPlayers", a.averagePlayers || 0);
  setText("statFeedback", a.feedbackCount || 0);

  renderMap("roleCounts", a.roleCounts || {}, "No role data yet.");
  renderMap("abilityUse", a.abilityUse || {}, "No ability data yet.");
}

function renderFeedback() {
  const filter = document.getElementById("feedbackFilter")?.value || "all";
  const list = document.getElementById("feedbackList");
  const filtered = filter === "all"
    ? adminFeedback
    : adminFeedback.filter(item => String(item.type || "general").toLowerCase() === filter);

  if (!filtered.length) {
    list.innerHTML = `<div class="emptyAdminState">No feedback found.</div>`;
    return;
  }

  list.innerHTML = filtered.map(item => `
    <article class="adminFeedbackItem">
      <div class="feedbackItemTop">
        <span class="feedbackTypeTag ${escapeHtml(item.type || "general")}">${labelForType(item.type)}</span>
        <small>${formatDate(item.date)}</small>
      </div>
      <p>${escapeHtml(item.message || "")}</p>
      <div class="feedbackMeta">
        <span>${escapeHtml(item.name || "Anonymous")}</span>
        ${item.roomId ? `<span>Room ${escapeHtml(item.roomId)}</span>` : ""}
        ${item.profileCode ? `<span>${escapeHtml(item.profileCode)}</span>` : ""}
      </div>
    </article>
  `).join("");
}

function renderPatchNotes(notes) {
  const box = document.getElementById("adminPatchNotes");
  if (!notes.length) {
    box.innerHTML = `<p class="hint">No patch notes yet.</p>`;
    return;
  }

  box.innerHTML = notes.map(note => `
    <div class="adminMiniRow">
      <b>${escapeHtml(note.version || "Version")}</b>
      <span>${escapeHtml(note.title || "Update")}</span>
    </div>
  `).join("");
}

function renderMap(id, map, emptyText) {
  const el = document.getElementById(id);
  const entries = Object.entries(map).sort((a, b) => Number(b[1]) - Number(a[1]));

  if (!entries.length) {
    el.innerHTML = `<p class="hint">${emptyText}</p>`;
    return;
  }

  el.innerHTML = entries.map(([key, value]) => `
    <div class="adminMiniRow"><b>${escapeHtml(key)}</b><span>${escapeHtml(value)}</span></div>
  `).join("");
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.innerText = value;
}

function labelForType(type) {
  const map = {
    bug: "🐛 Bug",
    feature: "💡 Feature",
    ui: "🎨 UI",
    balance: "⚖️ Balance",
    general: "⭐ General"
  };
  return map[String(type || "general").toLowerCase()] || "⭐ General";
}

function formatDate(dateString) {
  if (!dateString) return "Unknown date";
  try {
    return new Date(dateString).toLocaleString();
  } catch {
    return dateString;
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.getElementById("adminDashboard").style.display === "none") {
    loginAdmin();
  }
});
