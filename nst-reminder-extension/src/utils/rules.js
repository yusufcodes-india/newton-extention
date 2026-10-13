export function isPending(a) {
  return a.status !== "submitted";
}

export function overdueItems(assignments, nowMs) {
  return assignments.filter((a) => isPending(a) && a.dueAt < nowMs);
}

export function dueWithinItems(assignments, nowMs, leadMin) {
  const leadMs = leadMin * 60000;
  return assignments.filter(
    (a) => isPending(a) && a.dueAt >= nowMs && a.dueAt - nowMs <= leadMs
  );
}

export function dueTodayItems(assignments, nowMs) {
  const day = new Date(nowMs).toDateString();
  return assignments.filter(
    (a) => isPending(a) && new Date(a.dueAt).toDateString() === day
  );
}

export function attendanceBunksLeft(attended, total, thresholdPct) {
  const t = thresholdPct / 100;
  if (!(t > 0 && t < 1)) return 0;
  return Math.max(0, Math.floor(attended / t - total));
}

export function attendanceRisk(attendance, thresholdPct) {
  const t = thresholdPct ?? attendance.threshold ?? 75;
  if (attendance.percent === null || attendance.percent === undefined) {
    return { unknown: true, below: false, bunksLeft: 0 };
  }
  return {
    unknown: false,
    below: attendance.percent < t,
    bunksLeft: attendanceBunksLeft(attendance.attended, attendance.total, t),
  };
}

export function liveContests(contests, nowMs) {
  return contests
    .filter((c) => c.startsAt <= nowMs && nowMs <= c.endsAt)
    .sort((a, b) => a.endsAt - b.endsAt);
}

export function upcomingContests(contests, nowMs) {
  return contests
    .filter((c) => c.startsAt > nowMs)
    .sort((a, b) => a.startsAt - b.startsAt);
}

export function classesOnDay(timetable, dateStr) {
  return timetable
    .filter((t) => new Date(t.startsAt).toDateString() === dateStr)
    .sort((a, b) => a.startsAt - b.startsAt);
}

export function todaysClasses(timetable, nowMs) {
  return classesOnDay(timetable, new Date(nowMs).toDateString());
}

export function todayStr(nowMs) {
  const d = new Date(nowMs);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function qotdNeedsNudge(qotd, nowMs, nudgeHour) {
  if (qotd.solved && qotd.date === todayStr(nowMs)) return false;
  return new Date(nowMs).getHours() >= nudgeHour;
}

export function badgeCount(state, nowMs) {
  const settings = (state && state.settings) || {};
  const od = isSectionEnabled(settings, "assignments") ? overdueItems(state.assignments, nowMs) : [];
  const odIds = new Set(od.map((a) => a.id));
  const today = isSectionEnabled(settings, "assignments")
    ? dueTodayItems(state.assignments, nowMs).filter((a) => !odIds.has(a.id))
    : [];
  const live = isSectionEnabled(settings, "contests") ? liveContests(state.contests, nowMs) : [];
  return od.length + today.length + live.length;
}

export function digestSummary(state, nowMs) {
  const settings = (state && state.settings) || {};
  const risk = attendanceRisk(state.attendance, state.settings.attendanceThreshold);
  const tomorrow = new Date(nowMs);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    tomorrowsClasses: isSectionEnabled(settings, "classes")
      ? classesOnDay(state.timetable, tomorrow.toDateString())
      : [],
    dueSoon: isSectionEnabled(settings, "assignments")
      ? dueWithinItems(state.assignments, nowMs, 1440).sort((a, b) => a.dueAt - b.dueAt)
      : [],
    overdue: isSectionEnabled(settings, "assignments") ? overdueItems(state.assignments, nowMs) : [],
    upcoming: isSectionEnabled(settings, "contests")
      ? upcomingContests(state.contests, nowMs).slice(0, 3)
      : [],
    risk,
  };
}

export function notifiedKey(rule, entityId, nowMs) {
  return `${rule}:${entityId}:${todayStr(nowMs)}`;
}

export function alreadyNotified(meta, key) {
  return (meta.notifiedIds || []).includes(key);
}

export function markNotified(meta, key) {
  if (!alreadyNotified(meta, key)) {
    meta.notifiedIds = [...(meta.notifiedIds || []), key];
  }
  return meta;
}

export function pruneNotifiedIds(ids, nowMs) {
  const cutoff = nowMs - 7 * 86400000;
  return (ids || []).filter((k) => {
    const m = /:(\d{4}-\d{2}-\d{2})$/.exec(String(k));
    if (!m) return true;
    const t = Date.parse(m[1]);
    return Number.isNaN(t) || t >= cutoff;
  });
}

function toMins(s) {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

export function inQuietHours(settings, nowMs) {
  const q = settings.quietHours;
  if (!q || !q.start || !q.end) return false;
  const mins = new Date(nowMs).getHours() * 60 + new Date(nowMs).getMinutes();
  const start = toMins(q.start);
  const end = toMins(q.end);
  if (start <= end) return mins >= start && mins < end;
  return mins >= start || mins < end;
}

/** Section toggle: enabled unless explicitly switched off. Missing settings = enabled (backward compat). */
export function isSectionEnabled(settings, section) {
  if (!settings || !settings.enabledSections) return true;
  return settings.enabledSections[section] !== false;
}
