export const STORAGE_KEYS = [
  "attendance",
  "assignments",
  "contests",
  "timetable",
  "qotd",
  "settings",
  "meta",
  "authToken",
  "courseHash",
  "lastGoodHash",
];

export const DEFAULT_SETTINGS = {
  digestTime: "21:00",
  attendanceThreshold: 75,
  assignmentLeadsMin: [1440, 60],
  classLeadMin: 10,
  qotdNudgeHour: 18,
  quietHours: null,
  enabledSections: { attendance: true, assignments: true, contests: true, classes: true, qotd: true },
};

export const SECTION_KEYS = ["attendance", "assignments", "contests", "classes", "qotd"];

export function createInitialState() {
  return {
    attendance: { percent: null, attended: 0, total: 0, subjects: [], source: null, updatedAt: 0 },
    assignments: [],
    contests: [],
    timetable: [],
    qotd: { date: "", solved: false, streak: 0, title: "", slug: "", url: "", timeLeftMs: null, source: null, confidence: null, updatedAt: 0 },
    settings: { ...DEFAULT_SETTINGS, enabledSections: { ...DEFAULT_SETTINGS.enabledSections } },
    meta: { lastSyncAt: 0, notifiedIds: [], loggedOut: false, refresh: null },
    authToken: null,
    courseHash: null,
    lastGoodHash: null,
  };
}

export function normalizeState(raw) {
  const base = createInitialState();
  if (!raw || typeof raw !== "object") return base;
  const attendance = { ...base.attendance, ...(raw.attendance || {}) };
  if (!Array.isArray(attendance.subjects)) attendance.subjects = [];
  const meta = { ...base.meta, ...(raw.meta || {}) };
  meta.loggedOut = meta.loggedOut === true;
  meta.refresh = meta.refresh && typeof meta.refresh === "object" ? meta.refresh : null;
  const settings = { ...base.settings, ...(raw.settings || {}) };
  const rawSections = (raw.settings || {}).enabledSections;
  settings.enabledSections = {
    ...base.settings.enabledSections,
    ...((rawSections && typeof rawSections === "object" ? rawSections : {})),
  };
  return {
    attendance,
    assignments: Array.isArray(raw.assignments) ? raw.assignments : [],
    contests: Array.isArray(raw.contests) ? raw.contests : [],
    timetable: Array.isArray(raw.timetable) ? raw.timetable : [],
    qotd: { ...base.qotd, ...(raw.qotd || {}) },
    settings,
    meta,
    authToken: typeof raw.authToken === "string" && raw.authToken ? raw.authToken : null,
    courseHash: typeof raw.courseHash === "string" && raw.courseHash ? raw.courseHash : null,
    lastGoodHash: typeof raw.lastGoodHash === "string" && raw.lastGoodHash ? raw.lastGoodHash : null,
  };
}

function toNum(v) {
  if (v === "" || v === null || v === undefined) return NaN;
  return Number(v);
}

export function validateSettings(partial) {
  const p = partial && typeof partial === "object" ? partial : {};
  const out = { ...DEFAULT_SETTINGS };
  out.digestTime =
    typeof p.digestTime === "string" && /^\d{2}:\d{2}$/.test(p.digestTime)
      ? p.digestTime
      : "21:00";
  const t = toNum(p.attendanceThreshold);
  out.attendanceThreshold =
    Number.isFinite(t) && t >= 1 && t <= 99 ? Math.trunc(t) : 75;
  const cl = toNum(p.classLeadMin);
  out.classLeadMin =
    Number.isFinite(cl) && cl >= 1 && cl <= 120 ? Math.trunc(cl) : 10;
  const nh = toNum(p.qotdNudgeHour);
  out.qotdNudgeHour =
    Number.isFinite(nh) && nh >= 0 && nh <= 23 ? Math.trunc(nh) : 18;
  const leads = Array.isArray(p.assignmentLeadsMin)
    ? p.assignmentLeadsMin.filter((n) => Number.isFinite(n) && n > 0)
    : [];
  out.assignmentLeadsMin = leads.length ? leads : [1440, 60];
  const q = p.quietHours;
  out.quietHours =
    q &&
    typeof q === "object" &&
    /^\d{2}:\d{2}$/.test(q.start || "") &&
    /^\d{2}:\d{2}$/.test(q.end || "")
      ? { start: q.start, end: q.end }
      : null;
  const es = p.enabledSections && typeof p.enabledSections === "object" ? p.enabledSections : {};
  out.enabledSections = {};
  for (const k of SECTION_KEYS) out.enabledSections[k] = es[k] === false ? false : true;
  return out;
}

export function mergeById(existing, incoming) {
  const map = new Map(existing.map((e) => [e.id, e]));
  for (const item of incoming) {
    map.set(item.id, { ...(map.get(item.id) || {}), ...item });
  }
  return [...map.values()];
}

function isAutoItem(e) {
  if (!e) return false;
  const src = e.source || "";
  if (src === "auto" || src === "auto-api") return true;
  const id = String(e.id || "");
  return id.startsWith("auto-") || id.startsWith("api-assign-") || id.startsWith("api-contest-") || id.startsWith("api-quiz-") || id.startsWith("api-class-");
}

/** Replace auto-sourced assignments with a fresh API list; manual items survive. */
export function applyApiAssignments(state, items, nowMs) {
  const next = normalizeState(JSON.parse(JSON.stringify(state)));
  const list = Array.isArray(items) ? items : [];
  if (list.length > 0) {
    next.assignments = replaceAuto(
      next.assignments,
      list.map((i) => ({ ...i, updatedAt: nowMs }))
    );
    next.meta.lastSyncAt = nowMs;
  }
  return next;
}

/** Replace auto-sourced timetable with a fresh lecture-planner list. */
export function applyApiTimetable(state, items, nowMs) {
  const next = normalizeState(JSON.parse(JSON.stringify(state)));
  const list = Array.isArray(items) ? items : [];
  if (list.length > 0) {
    next.timetable = replaceAuto(
      next.timetable,
      list.map((i) => ({ ...i, updatedAt: nowMs }))
    );
    next.meta.lastSyncAt = nowMs;
  }
  return next;
}
/** Replace auto-sourced contests with a fresh API list; manual items survive. */
export function applyApiContests(state, items, nowMs) {
  const next = normalizeState(JSON.parse(JSON.stringify(state)));
  const list = Array.isArray(items) ? items : [];
  if (list.length > 0) {
    next.contests = replaceAuto(
      next.contests,
      list.map((i) => ({ ...i, updatedAt: nowMs }))
    );
    next.meta.lastSyncAt = nowMs;
  }
  return next;
}

function replaceAuto(existing, incoming) {
  const incomingIds = new Set(incoming.map((i) => i.id));
  const kept = (existing || []).filter(
    (e) => !isAutoItem(e) && !incomingIds.has(e.id)
  );
  return [...kept, ...incoming];
}

export function applySync(state, pageType, parsed, nowMs) {
  const next = normalizeState(JSON.parse(JSON.stringify(state)));
  if (!parsed || typeof parsed !== "object") return next;
  if (
    pageType === "attendance" &&
    parsed.percent !== null &&
    parsed.percent !== undefined &&
    (next.attendance.source !== "api" || parsed.confidence === "high")
  ) {
    next.attendance = {
      percent: parsed.percent,
      attended: parsed.attended ?? next.attendance.attended,
      total: parsed.total ?? next.attendance.total,
      subjects: next.attendance.subjects,
      source: "page",
      updatedAt: nowMs,
    };
    if (parsed.confidence !== undefined) {
      next.attendance.confidence = parsed.confidence;
    }
    next.meta.lastSyncAt = nowMs;
  }
  if (pageType === "assignments" && Array.isArray(parsed.items) && parsed.items.length > 0) {
    next.assignments = replaceAuto(
      next.assignments,
      parsed.items.map((i) => ({ ...i, updatedAt: nowMs }))
    );
    next.meta.lastSyncAt = nowMs;
  }
  if (pageType === "contest" && Array.isArray(parsed.items) && parsed.items.length > 0) {
    next.contests = replaceAuto(
      next.contests,
      parsed.items.map((i) => ({ ...i, updatedAt: nowMs }))
    );
    next.meta.lastSyncAt = nowMs;
  }
  if (pageType === "schedule" && Array.isArray(parsed.items) && parsed.items.length > 0) {
    next.timetable = replaceAuto(
      next.timetable,
      parsed.items.map((i) => ({ ...i, updatedAt: nowMs }))
    );
    next.meta.lastSyncAt = nowMs;
  }
  if (pageType === "qotd" && parsed.qotd && typeof parsed.qotd === "object") {
    next.qotd = { ...next.qotd, ...parsed.qotd };
    if (parsed.confidence !== undefined) {
      next.qotd.confidence = parsed.confidence;
    }
    next.qotd.source = parsed.qotd.source || "auto";
    next.meta.lastSyncAt = nowMs;
  }
  return next;
}

/** Write API-fetched attendance. subjects: [{hash,title,attended,total,stale}]. */
export function applyApiAttendance(state, { subjects, attended, total }, nowMs) {
  const next = normalizeState(JSON.parse(JSON.stringify(state)));
  const list = Array.isArray(subjects) ? subjects : [];
  const a = Number.isFinite(attended) ? attended : list.reduce((t, s) => t + (s.attended || 0), 0);
  const n = Number.isFinite(total) ? total : list.reduce((t, s) => t + (s.total || 0), 0);
  next.attendance = {
    percent: n > 0 ? Math.round((100 * a) / n * 10) / 10 : null,
    attended: a,
    total: n,
    subjects: list.map((s) => ({
      hash: s.hash,
      title: s.title,
      attended: s.attended || 0,
      total: s.total || 0,
      stale: s.stale === true,
    })),
    source: "api",
    confidence: "high",
    updatedAt: nowMs,
  };
  next.meta.lastSyncAt = nowMs;
  next.meta.loggedOut = false;
  return next;
}

/** Write API-fetched QOTD. Preserves streak when the API carries none. */
export function applyApiQotd(state, qotd, nowMs) {
  const next = normalizeState(JSON.parse(JSON.stringify(state)));
  if (!qotd || typeof qotd !== "object") return next;
  next.qotd = {
    ...next.qotd,
    date: typeof qotd.date === "string" ? qotd.date : next.qotd.date,
    solved: typeof qotd.solved === "boolean" ? qotd.solved : next.qotd.solved,
    streak: Number.isInteger(qotd.streak) ? qotd.streak : next.qotd.streak || 0,
    title: typeof qotd.title === "string" ? qotd.title : next.qotd.title || "",
    slug: typeof qotd.slug === "string" ? qotd.slug : next.qotd.slug || "",
    url: typeof qotd.url === "string" ? qotd.url : next.qotd.url || "",
    timeLeftMs: typeof qotd.timeLeftMs === "number" && Number.isFinite(qotd.timeLeftMs) ? qotd.timeLeftMs : null,
    source: "api",
    confidence: "high",
    updatedAt: nowMs,
  };
  next.meta.lastSyncAt = nowMs;
  return next;
}

/** Mark the session logged out / expired without touching data or lastSyncAt. */
export function markLoggedOut(state) {
  const next = normalizeState(JSON.parse(JSON.stringify(state)));
  next.meta.loggedOut = true;
  return next;
}
