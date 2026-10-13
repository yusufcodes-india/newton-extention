import { SECTION_KEYS, normalizeState, validateSettings } from "./utils/storage.js";
import {
  attendanceRisk,
  dueTodayItems,
  dueWithinItems,
  isSectionEnabled,
  liveContests,
  overdueItems,
  qotdNeedsNudge,
  todaysClasses,
  upcomingContests,
} from "./utils/rules.js";

const $ = (id) => document.getElementById(id);
const fmt = (ts) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const autoTag = (item) => (item && item.source === "auto" ? " <small>auto, verify</small>" : "");
const isHttps = (u) => /^https:\/\//i.test(u || "");
const notifyable = (i) => i && i.confidence !== "low" && i.confidence !== "none";

const TABS = ["attendance", "alerts", "assignments", "settings"];

/* ---------- tabs ---------- */

function showTab(name, persist = true) {
  if (!TABS.includes(name)) name = "attendance";
  for (const t of TABS) {
    const on = t === name;
    $("page-" + t).hidden = !on;
    const btn = $("tab-" + t);
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
  }
  if (persist) {
    try {
      chrome.storage.local.set({ uiTab: name });
    } catch (e) {}
  }
}

function initTabs() {
  for (const t of TABS) {
    $("tab-" + t).addEventListener("click", () => showTab(t));
  }
  $("tab-attendance").parentElement.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const cur = TABS.findIndex((t) => $("tab-" + t).getAttribute("aria-selected") === "true");
    const next = (cur + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    showTab(TABS[next]);
    $("tab-" + TABS[next]).focus();
  });
}

/* ---------- alerts (page 2) ---------- */

function relTime(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function buildAlerts(state, now) {
  const out = [];
  const s = state.settings;
  const on = (k) => isSectionEnabled(s, k);

  if (state.meta.loggedOut) {
    out.push({ tone: "bad", title: "Auto-sync paused", detail: "Your Newton session expired. Sign in again to resume." });
  }

  if (on("attendance")) {
    const risk = attendanceRisk(state.attendance, s.attendanceThreshold);
    if (!risk.unknown && risk.below) {
      out.push({
        tone: "bad",
        title: "Attendance below threshold",
        detail: `${state.attendance.percent}% against your ${s.attendanceThreshold}% limit. Attend upcoming classes.`,
      });
    } else if (!risk.unknown && risk.bunksLeft <= 2) {
      out.push({
        tone: "warn",
        title: "Attendance is close to the limit",
        detail: `${state.attendance.percent}% with ${risk.bunksLeft} ${risk.bunksLeft === 1 ? "bunk" : "bunks"} left.`,
      });
    }
  }

  if (on("assignments")) {
    const od = overdueItems(state.assignments, now).filter(notifyable);
    for (const a of od) {
      out.push({ tone: "bad", title: `Overdue: ${a.title}`, detail: `Was due ${fmt(a.dueAt)}` });
    }
    const maxLead = Math.max(60, ...(s.assignmentLeadsMin || []));
    const soon = dueWithinItems(state.assignments, now, maxLead)
      .filter((a) => notifyable(a) && a.status !== "submitted" && !od.some((o) => o.id === a.id))
      .sort((a, b) => a.dueAt - b.dueAt);
    for (const a of soon) {
      out.push({ tone: "warn", title: `Due soon: ${a.title}`, detail: `Due ${fmt(a.dueAt)} (in ${relTime(a.dueAt - now)})` });
    }
  }

  if (on("classes")) {
    const next = todaysClasses(state.timetable, now)
      .filter((c) => notifyable(c) && c.startsAt >= now && c.startsAt - now <= 60 * 60000)
      .sort((a, b) => a.startsAt - b.startsAt);
    for (const c of next) {
      out.push({ tone: "info", title: `Class soon: ${c.title}`, detail: `Starts ${fmt(c.startsAt)} (in ${relTime(c.startsAt - now)})` });
    }
  }

  if (on("contests")) {
    for (const c of liveContests(state.contests, now).filter(notifyable)) {
      out.push({ tone: "ok", title: `Contest live: ${c.title}`, detail: "Running right now." });
    }
  }

  if (on("qotd") && state.qotd && state.qotd.source && notifyable(state.qotd)) {
    if (qotdNeedsNudge(state.qotd, now, s.qotdNudgeHour)) {
      out.push({ tone: "warn", title: "Question of the Day is unsolved", detail: "Solve it to keep your streak alive." });
    }
  }

  return out;
}

function renderAlerts(state, now) {
  const alerts = buildAlerts(state, now);
  $("alerts").innerHTML = alerts.length
    ? alerts
        .map((a) => `<li class="tone-${a.tone}"><span class="a-title">${esc(a.title)}</span><span class="a-detail">${esc(a.detail)}</span></li>`)
        .join("")
    : `<li class="tone-ok empty"><span class="a-title">All clear</span><span class="a-detail">Nothing needs your attention right now.</span></li>`;

  const urgent = alerts.filter((a) => a.tone === "bad" || a.tone === "warn").length;
  $("alertCount").hidden = urgent === 0;
  $("alertCount").textContent = String(urgent);
}

/* ---------- main render ---------- */

async function load() {
  const state = normalizeState(await chrome.storage.local.get(null));
  const now = Date.now();

  const ageHrs = (now - state.meta.lastSyncAt) / 3600000;
  $("syncAge").textContent =
    state.meta.lastSyncAt === 0 ? "never synced" : `synced ${ageHrs < 1 ? "just now" : `${Math.floor(ageHrs)}h ago`}`;
  $("stale").hidden = !(state.meta.lastSyncAt === 0 || now - state.meta.lastSyncAt > 86400000);
  $("loggedOut").hidden = !state.meta.loggedOut;
  const rep = state.meta.refresh;
  $("syncDetail").textContent = rep
    ? `sync ${fmt(rep.at)} | att ${rep.attendance} | asg ${rep.assignments} | con ${rep.contests} | tt ${rep.timetable} | qotd ${rep.qotd ?? "-"}`
    : "No sync yet. Hit ↻ while logged into Newton.";

  const on = (k) => isSectionEnabled(state.settings, k);

  // Page 2: alerts
  renderAlerts(state, now);

  // Page 3: classes
  if (!on("classes")) {
    $("today").innerHTML = "<li>Class tracking is off. Turn it on in Settings.</li>";
  } else {
    $("today").innerHTML =
      todaysClasses(state.timetable, now)
        .map((t) =>
          t.joinUrl && isHttps(t.joinUrl)
            ? `<li>${esc(t.title)}, ${fmt(t.startsAt)}${autoTag(t)} <a href="${esc(t.joinUrl)}" target="_blank" rel="noopener">Join</a></li>`
            : `<li>${esc(t.title)}, ${fmt(t.startsAt)}${autoTag(t)}</li>`
        )
        .join("") || "<li>No classes today.</li>";
  }

  // Page 3: assignments
  if (!on("assignments")) {
    $("assign").innerHTML = "<li>Assignment tracking is off. Turn it on in Settings.</li>";
  } else {
    const od = overdueItems(state.assignments, now);
    const today = dueTodayItems(state.assignments, now).filter((a) => !od.some((o) => o.id === a.id));
    const rest = state.assignments
      .filter((a) => a.status !== "submitted" && !od.some((o) => o.id === a.id) && !today.some((t) => t.id === a.id))
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, 10);
    const row = (a, cls) => `<li class="${cls}">${esc(a.title)}, ${fmt(a.dueAt)}${autoTag(a)}</li>`;
    $("assign").innerHTML =
      od.map((a) => row(a, "overdue")).join("") +
        today.map((a) => row(a, "today")).join("") +
        rest.map((a) => row(a, "")).join("") || "<li>No assignments tracked yet.</li>";
  }

  // Page 1: attendance
  if (!on("attendance")) {
    $("attend").innerHTML = "Attendance tracking is off. Turn it on in Settings.";
  } else {
    const risk = attendanceRisk(state.attendance, state.settings.attendanceThreshold);
    if (risk.unknown) {
      $("attend").innerHTML = "No attendance data yet. Hit ↻ while logged into Newton.";
    } else {
      const pct = state.attendance.percent;
      const barPct = Math.max(0, Math.min(100, pct));
      const thr = state.settings.attendanceThreshold;
      const subjRows = (state.attendance.subjects || [])
        .map((s) => {
          const sp = s.total > 0 ? Math.round((100 * s.attended) / s.total) : null;
          return `<li><span class="s-name">${esc(s.title)}${s.stale ? " <small>stale</small>" : ""}</span><span class="s-pct">${
            sp === null ? "-" : `${sp}%`
          }</span><div class="s-bar"><div style="width:${sp === null ? 0 : Math.max(0, Math.min(100, sp))}%"></div></div></li>`;
        })
        .join("");
      $("attend").innerHTML =
        `<div class="hero-top"><span class="hero-pct">${pct}<span class="unit">%</span></span>` +
        `<span class="hero-sub">${state.attendance.attended}/${state.attendance.total} classes<br>${
          risk.below ? "Below threshold" : `${risk.bunksLeft} bunks left`
        }</span></div>` +
        `<div class="bar"><div class="fill" style="width:${barPct}%"></div>` +
        `<div class="tick" style="left:${thr}%"></div></div>` +
        (subjRows ? `<ul>${subjRows}</ul>` : "");
    }
  }

  // Page 3: contests
  if (!on("contests")) {
    $("contests").innerHTML = "<li>Contest tracking is off. Turn it on in Settings.</li>";
  } else {
    $("contests").innerHTML =
      liveContests(state.contests, now)
        .map((c) => `<li class="live">Live: ${esc(c.title)}${autoTag(c)}</li>`)
        .join("") +
        upcomingContests(state.contests, now)
          .slice(0, 5)
          .map((c) => `<li>${esc(c.title)}, ${fmt(c.startsAt)}${autoTag(c)}</li>`)
          .join("") || "<li>No contests tracked.</li>";
  }

  // Page 3: QOTD
  if (!on("qotd")) {
    $("qotd").textContent = "QOTD tracking is off. Turn it on in Settings.";
  } else {
    const q = state.qotd || {};
    if (!q.source && !q.title) {
      $("qotd").textContent = "No QOTD yet. Hit ↻ to fetch today's problem.";
    } else {
      const left =
        typeof q.timeLeftMs === "number" && Number.isFinite(q.timeLeftMs) && q.timeLeftMs > 0
          ? `, ${Math.floor(q.timeLeftMs / 3600000)}h ${Math.floor((q.timeLeftMs % 3600000) / 60000)}m left`
          : "";
      const streak = q.streak ? `, streak ${q.streak}` : "";
      const status = q.solved ? "Solved" : "Unsolved";
      const title = q.title ? esc(q.title) : "Today's problem";
      const date = q.date ? ` (${esc(q.date)})` : "";
      if (q.url && isHttps(q.url)) {
        $("qotd").innerHTML = `${status}${date}: <a href="${esc(q.url)}" target="_blank" rel="noopener">${title}</a>${streak}${left}`;
      } else {
        $("qotd").textContent = `${status}${date}: ${q.title || "Today's problem"}${streak}${left}`;
      }
    }
  }
}

/* ---------- settings (page 4) ---------- */

function initSettings(state) {
  const s = state.settings;
  $("digestTime").value = s.digestTime;
  $("threshold").value = s.attendanceThreshold;
  $("leads").value = s.assignmentLeadsMin.join(", ");
  $("classLead").value = s.classLeadMin;
  $("nudgeHour").value = s.qotdNudgeHour;
  for (const k of SECTION_KEYS) {
    const box = $("sec-" + k);
    if (box) box.checked = !s.enabledSections || s.enabledSections[k] !== false;
  }
  if (s.quietHours) {
    $("quietStart").value = s.quietHours.start;
    $("quietEnd").value = s.quietHours.end;
  }

  $("opts").addEventListener("submit", async (e) => {
    e.preventDefault();
    const leads = $("leads")
      .value.split(",")
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    const cur = normalizeState(await chrome.storage.local.get(null));
    const enabledSections = {};
    for (const k of SECTION_KEYS) {
      const box = $("sec-" + k);
      enabledSections[k] = box ? box.checked : true;
    }
    cur.settings = validateSettings({
      digestTime: $("digestTime").value,
      attendanceThreshold: $("threshold").value,
      assignmentLeadsMin: leads,
      classLeadMin: $("classLead").value,
      qotdNudgeHour: $("nudgeHour").value,
      enabledSections,
      quietHours:
        $("quietStart").value && $("quietEnd").value
          ? { start: $("quietStart").value, end: $("quietEnd").value }
          : null,
    });
    await chrome.storage.local.set({ settings: cur.settings });
    $("saved").hidden = false;
    setTimeout(() => ($("saved").hidden = true), 1500);
    load();
  });
}

function markTheme(name) {
  for (const b of $("themes").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.theme === name));
  }
}

function initTheme(current) {
  markTheme(current);
  $("themes").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-theme]");
    if (!btn) return;
    markTheme(btn.dataset.theme);
    await chrome.storage.local.set({ uiTheme: btn.dataset.theme });
  });
}

function initWhatsApp() {
  const ver = chrome.runtime.getManifest().version;
  $("wa").href = "https://wa.me/916359242153?text=" + encodeURIComponent(`Hi! I have a query about NST Reminder (v${ver}): `);
  $("ver").textContent = `NST Reminder v${ver}`;
}

/* ---------- boot ---------- */

$("refresh").addEventListener("click", async () => {
  $("refresh").disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "NST_REFRESH" });
  } catch (e) {
    /* worker unreachable; render cache */
  }
  $("refresh").disabled = false;
  load();
});

(async function boot() {
  const raw = await chrome.storage.local.get(null);
  initTabs();
  showTab(raw.uiTab, false);
  initSettings(normalizeState(raw));
  initTheme(raw.uiTheme || "off");
  initWhatsApp();
  load();
})();
