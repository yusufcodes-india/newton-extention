import { applyApiAssignments, applyApiAttendance, applyApiContests, applyApiQotd, applyApiTimetable, markLoggedOut, normalizeState } from "./utils/storage.js";
import { NewtonError, fetchAssignments, fetchContests, fetchLectures, fetchPerformance, fetchQotd, fetchQuizzes, fetchUnits, pickCourse } from "./utils/newton.js";
import {
  alreadyNotified,
  attendanceRisk,
  badgeCount,
  digestSummary,
  dueWithinItems,
  inQuietHours,
  isSectionEnabled,
  liveContests,
  markNotified,
  notifiedKey,
  overdueItems,
  pruneNotifiedIds,
  qotdNeedsNudge,
  todaysClasses,
} from "./utils/rules.js";

function classesStartingSoon(timetable, nowMs, leadMin) {
  const leadMs = leadMin * 60000;
  return todaysClasses(timetable, nowMs).filter(
    (t) => t.startsAt >= nowMs && t.startsAt - nowMs <= leadMs
  );
}

async function readState() {
  return normalizeState(await chrome.storage.local.get(null));
}

async function ensureDailyAlarms(settings) {
  const [h, m] = settings.digestTime.split(":").map(Number);
  const next = new Date();
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  chrome.alarms.create("daily-digest", { when: next.getTime(), periodInMinutes: 1440 });
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  chrome.alarms.create("midnight-rollover", { when: midnight.getTime(), periodInMinutes: 1440 });
}

async function notify(id, title, message) {
  await chrome.notifications.create(id, { type: "basic", iconUrl: "icons/icon128.png", title, message });
}

function isNotifyable(item) {
  return item && item.confidence !== "low" && item.confidence !== "none";
}

async function tryNotify(id, title, message, state, key) {
  try {
    await notify(id, title, message);
    markNotified(state.meta, key);
  } catch (e) {
    /* one failed notification must not abort the rest */
  }
}

async function evaluateRules(state) {
  const now = Date.now();
  const quiet = inQuietHours(state.settings, now);

  if (isSectionEnabled(state.settings, "assignments")) {
  for (const lead of state.settings.assignmentLeadsMin) {
    for (const a of dueWithinItems(state.assignments, now, lead)) {
      if (!isNotifyable(a)) continue;
      const key = notifiedKey(`assign-${lead}`, a.id, now);
      if (alreadyNotified(state.meta, key)) continue;
      if (quiet) continue;
      await tryNotify(key, "Assignment due soon", `${a.title} due ${new Date(a.dueAt).toLocaleString()}`, state, key);
    }
  }
  for (const a of overdueItems(state.assignments, now)) {
    if (!isNotifyable(a)) continue;
    const key = notifiedKey("overdue", a.id, now);
    if (alreadyNotified(state.meta, key)) continue;
    if (quiet) continue;
    await tryNotify(key, "Assignment overdue", a.title, state, key);
  }
  }
  if (isSectionEnabled(state.settings, "classes")) {
  for (const c of classesStartingSoon(state.timetable, now, state.settings.classLeadMin)) {
    if (!isNotifyable(c)) continue;
    const key = notifiedKey("class", c.id, now);
    if (alreadyNotified(state.meta, key)) continue;
    if (quiet) continue;
    await tryNotify(key, "Class starting soon", `${c.title} at ${new Date(c.startsAt).toLocaleTimeString()}`, state, key);
  }
  }
  if (isSectionEnabled(state.settings, "contests")) {
  for (const c of liveContests(state.contests, now)) {
    if (!isNotifyable(c)) continue;
    const key = notifiedKey("live", c.id, now);
    if (alreadyNotified(state.meta, key)) continue;
    if (quiet) continue;
    await tryNotify(key, "Contest live", c.title, state, key);
  }
  }
  const risk = attendanceRisk(state.attendance, state.settings.attendanceThreshold);
  if (isSectionEnabled(state.settings, "attendance") && !risk.unknown && risk.below && isNotifyable(state.attendance)) {
    const key = notifiedKey("attendance-risk", "overall", now);
    if (!alreadyNotified(state.meta, key) && !quiet) {
      await tryNotify(key, "Attendance below threshold", `${state.attendance.percent}% — attend upcoming classes`, state, key);
    }
  }
  if (
    isSectionEnabled(state.settings, "qotd") &&
    state.qotd.source &&
    isNotifyable(state.qotd) &&
    qotdNeedsNudge(state.qotd, now, state.settings.qotdNudgeHour)
  ) {
    const key = notifiedKey("qotd", "daily", now);
    if (!alreadyNotified(state.meta, key) && !quiet) {
      await tryNotify(key, "Question of the Day", "Today's problem is still unsolved — keep the streak alive", state, key);
    }
  }
  // Low-confidence rule (badge-only by design): never notify from low-confidence parses.
  await chrome.action.setBadgeText({ text: String(badgeCount(state, now) || "") });
  await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
  await chrome.storage.local.set({ meta: state.meta });
}

async function sendDigest(state) {
  const d = digestSummary(state, Date.now());
  const lines = [];
  lines.push(`Overdue: ${d.overdue.length}`);
  lines.push(`Due in 24h: ${d.dueSoon.length}`);
  lines.push(`Classes tomorrow: ${d.tomorrowsClasses.length}`);
  lines.push(`Upcoming contests: ${d.upcoming.length}`);
  lines.push(d.risk.unknown ? "Attendance: unknown" : `Attendance: ${state.attendance.percent}% (${d.risk.bunksLeft} bunks left)`);
  await notify(`digest-${Date.now()}`, "NST daily digest", lines.join("\n"));
}

async function handleSync(msg) {
  await refreshAttendance({ force: true });
}

const API_TTL_MS = 30 * 60 * 1000;

async function loggedOutNudge(state, now, message) {
  const key = notifiedKey("logged-out", "portal", now);
  if (alreadyNotified(state.meta, key)) return;
  if (inQuietHours(state.settings, now)) return;
  await tryNotify(key, "Newton auto-sync paused", message, state, key);
}

/** Pull attendance from Newton's API using the stored session token. QOTD is best-effort (works anonymous). */
async function refreshAttendance({ force = false } = {}) {
  const state = await readState();
  const now = Date.now();
  if (!state.authToken) {
    const next = markLoggedOut(state);
    const wantQotdAnon = isSectionEnabled(state.settings, "qotd");
    next.meta.refresh = { at: now, attendance: "skipped:no-token", assignments: "skipped:no-token", contests: "skipped:no-token", timetable: "skipped:no-token", qotd: wantQotdAnon ? "skipped" : "skipped:disabled" };
    if (wantQotdAnon) {
    try {
      const qotd = await fetchQotd(fetch, null);
      const withQotd = applyApiQotd(next, qotd, now);
      next.qotd = withQotd.qotd;
      next.meta.lastSyncAt = withQotd.meta.lastSyncAt;
      next.meta.refresh.qotd = `ok:${qotd.title.slice(0, 40)}`;
    } catch (e) {
      next.meta.refresh.qotd = `error:${(e && e.code) || "network"}`;
    }
    }
    await chrome.storage.local.set({ meta: next.meta, qotd: next.qotd });
    await loggedOutNudge(next, now, "Open my.newtonschool.co while signed in to connect attendance.");
    await evaluateRules(next);
    return { ok: false, code: "no-token" };
  }
  if (!force && state.attendance.source === "api" && now - state.attendance.updatedAt < API_TTL_MS) {
    await evaluateRules(state);
    return { ok: true, skipped: true };
  }
  try {
    const wantAttendance = isSectionEnabled(state.settings, "attendance");
    const wantAssignments = isSectionEnabled(state.settings, "assignments");
    const wantContests = isSectionEnabled(state.settings, "contests");
    const wantClasses = isSectionEnabled(state.settings, "classes");
    const wantQotd = isSectionEnabled(state.settings, "qotd");
    const wantCourse = wantAttendance || wantAssignments || wantContests || wantClasses;
    let unit = null;
    let results = [];
    if (wantCourse) {
      const units = await fetchUnits(fetch, state.authToken);
      if (units.length === 0) throw new NewtonError("no-course");
      unit = pickCourse(units, [state.courseHash, state.lastGoodHash]);
      if (!unit) {
        await evaluateRules(state);
        return { ok: false, code: "pick-course" };
      }
      if (wantAttendance) {
        results = await Promise.allSettled(
          unit.subjects.map((s) => fetchPerformance(fetch, state.authToken, s.hash))
        );
        if (results.some((r) => r.status === "rejected" && r.reason && r.reason.code === "auth")) {
          throw new NewtonError("auth");
        }
      }
    }
    const next = normalizeState(JSON.parse(JSON.stringify(state)));
    const rep = {
      at: now,
      attendance: wantAttendance ? "ok" : "skipped:disabled",
      assignments: wantAssignments ? "skipped" : "skipped:disabled",
      contests: wantContests ? "skipped" : "skipped:disabled",
      timetable: wantClasses ? "skipped" : "skipped:disabled",
      qotd: wantQotd ? "skipped" : "skipped:disabled",
    };
    if (unit && wantAttendance) {
    const prev = new Map((state.attendance.subjects || []).map((s) => [s.hash, s]));
    const subjects = [];
    for (let i = 0; i < unit.subjects.length; i++) {
      const sub = unit.subjects[i];
      const r = results[i];
      if (r.status === "fulfilled") {
        subjects.push({ hash: sub.hash, title: sub.title, attended: r.value.attended, total: r.value.total, stale: false });
      } else if (prev.get(sub.hash)) {
        subjects.push({ ...prev.get(sub.hash), title: sub.title, stale: true });
      }
    }
    if (subjects.length === 0) throw new NewtonError("network");
    const a = subjects.reduce((t, s) => t + s.attended, 0);
    const n = subjects.reduce((t, s) => t + s.total, 0);
    const withAtt = applyApiAttendance(next, { subjects, attended: a, total: n }, now);
    next.attendance = withAtt.attendance;
    next.meta.lastSyncAt = withAtt.meta.lastSyncAt;
    next.meta.loggedOut = false;
    }
    if (unit) {
    if (!next.courseHash && unit.hash) next.courseHash = unit.hash;
    if (unit.hash) next.lastGoodHash = unit.hash;
    }
    try {
      const hash = next.courseHash || next.lastGoodHash;
      if (!hash) {
        if (wantAssignments) rep.assignments = "skipped:no-hash";
        if (wantContests) rep.contests = "skipped:no-hash";
        if (wantClasses) rep.timetable = "skipped:no-hash";
      } else {
        if (wantAssignments) {
        let items = [];
        try {
          items = await fetchAssignments(fetch, state.authToken, hash);
          rep.assignments = `fetched:${items.length}`;
        } catch (e) {
          rep.assignments = `error:${(e && e.code) || "network"}`;
        }
        try {
          const quizzes = await fetchQuizzes(fetch, state.authToken, hash);
          const seen = new Set(items.map((i) => i.id));
          let added = 0;
          for (const q of quizzes) if (!seen.has(q.id)) { items.push(q); added++; }
          rep.assignments += `+quiz:${added}`;
        } catch (e2) {
          rep.assignments += `:quiz-err:${(e2 && e2.code) || "network"}`;
        }
        const withAssign = applyApiAssignments(next, items, now);
        next.assignments = withAssign.assignments;
        next.meta.lastSyncAt = withAssign.meta.lastSyncAt;
        rep.assignments += `:stored:${next.assignments.length}`;
        }
        if (wantContests) {
        try {
          const contests = await fetchContests(fetch, state.authToken, hash);
          const withContests = applyApiContests(next, contests, now);
          next.contests = withContests.contests;
          next.meta.lastSyncAt = withContests.meta.lastSyncAt;
          rep.contests = `ok:${contests.length}:stored:${next.contests.length}`;
        } catch (e2) {
          rep.contests = `error:${(e2 && e2.code) || "network"}`;
        }
        }
        if (wantClasses) {
        try {
          const classes = await fetchLectures(fetch, state.authToken, hash);
          const withTT = applyApiTimetable(next, classes, now);
          next.timetable = withTT.timetable;
          next.meta.lastSyncAt = withTT.meta.lastSyncAt;
          rep.timetable = `ok:${classes.length}:stored:${next.timetable.length}`;
        } catch (e3) {
          rep.timetable = `error:${(e3 && e3.code) || "network"}`;
        }
        }
      }
      if (wantQotd) {
        try {
          const qotd = await fetchQotd(fetch, state.authToken);
          const withQotd = applyApiQotd(next, qotd, now);
          next.qotd = withQotd.qotd;
          next.meta.lastSyncAt = withQotd.meta.lastSyncAt;
          rep.qotd = `ok:${qotd.solved ? "solved" : "unsolved"}:${qotd.title.slice(0, 40)}`;
        } catch (e4) {
          if (e4 && e4.code === "auth") throw e4;
          rep.qotd = `error:${(e4 && e4.code) || "network"}`;
        }
      }
      next.meta.loggedOut = false;
    } catch (e) {
      if (e && e.code === "auth") throw e;
      rep.assignments += "|outer-fail";
    }
    next.meta.refresh = rep;
    await chrome.storage.local.set(next);
    await evaluateRules(next);
    return { ok: true };
  } catch (err) {
    const code = (err && err.code) || "network";
    if (code === "auth") {
      const next = markLoggedOut(state);
      await chrome.storage.local.set({ meta: next.meta });
      await loggedOutNudge(next, now, "Your Newton session expired — sign in again to resume auto-sync.");
      await evaluateRules(next);
    }
    return { ok: false, code };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await readState();
  await chrome.storage.local.set(state);
  chrome.alarms.create("sync-check", { periodInMinutes: 15 });
  await ensureDailyAlarms(state.settings);
  await refreshAttendance();
});

chrome.runtime.onStartup.addListener(async () => {
  await refreshAttendance();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "NST_REFRESH") {
    refreshAttendance({ force: true }).then(
      (r) => sendResponse(r),
      () => sendResponse({ ok: false, code: "network" })
    );
    return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings && changes.settings.newValue) {
    void ensureDailyAlarms(changes.settings.newValue);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const state = await readState();
  if (alarm.name === "midnight-rollover") {
    state.meta.notifiedIds = pruneNotifiedIds(state.meta.notifiedIds, Date.now());
    await chrome.storage.local.set({ meta: state.meta });
  }
  if (alarm.name === "sync-check" || alarm.name === "midnight-rollover") await refreshAttendance();
  if (alarm.name === "daily-digest") {
    if (!inQuietHours(state.settings, Date.now())) await sendDigest(state);
  }
});
