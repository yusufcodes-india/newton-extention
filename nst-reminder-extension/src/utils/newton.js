// Newton's API client. Pure ESM: fetch is injected so Node can test with stubs.
// Endpoints observed from live portal traffic: Bearer token auth, JSON only.
const BASE = "https://my.newtonschool.co";
const TIMEOUT_MS = 12000;

export class NewtonError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

async function getJson(fetchImpl, path, token, timeoutMs = TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(BASE + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: ctl.signal,
      cache: "no-store",
      credentials: "omit",
    });
  } catch (e) {
    throw new NewtonError(ctl.signal.aborted ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new NewtonError("auth");
  if (!res.ok) throw new NewtonError("http", `HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (_) {
    throw new NewtonError("shape");
  }
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

/** Course list -> [{ hash, name, subjects: [{ hash, title }] }]. Throws NewtonError('shape') on unknown shape. */
export function parseUnits(json) {
  const courses = Array.isArray(json) ? json : asArray(json && json.results);
  const list = [];
  for (const c of courses) {
    const units = asArray(c && c.children_courses && c.children_courses.admin_unit_courses);
    for (const u of units) {
      const hash = str(u && u.hash);
      if (!hash) continue;
      const subjects = asArray(u.learning_unit_courses)
        .map((s) => ({
          hash: str(s && s.hash),
          title: str((s && (s.short_display_name || s.title || s.name)) || "") || "Subject",
        }))
        .filter((s) => s.hash);
      list.push({
        hash,
        name: str((u && (u.short_display_name || u.title || u.name)) || "") || str((c && (c.short_display_name || c.title || c.name)) || "") || "Your course",
        subjects,
      });
    }
  }
  if (!Array.isArray(json) && !Array.isArray(json && json.results)) throw new NewtonError("shape");
  return list;
}

/** Performance payload -> { total, attended }. Throws NewtonError('shape') on bad numbers. */
export function parsePerformance(json) {
  const n = json && json.total_lectures;
  const a = json && json.total_lectures_attended;
  if (!Number.isInteger(n) || !Number.isInteger(a) || n < 0 || a < 0 || a > n) {
    throw new NewtonError("shape");
  }
  return { total: n, attended: a };
}

/** Pick the active course: first hash match wins; single-unit list auto-picks; multi-unit ambiguity returns null. */
export function pickCourse(units, hashes) {
  const list = asArray(units);
  for (const h of asArray(hashes)) {
    if (!h) continue;
    const u = list.find((x) => x && x.hash === h);
    if (u) return u;
  }
  if (list.length === 1) return list[0];
  return null;
}

export async function fetchUnits(fetchImpl, token, timeoutMs) {
  if (!token) throw new NewtonError("no-token");
  return parseUnits(
    await getJson(fetchImpl, "/api/v2/course/all/applied/?pagination=false&completed=false", token, timeoutMs)
  );
}

export async function fetchPerformance(fetchImpl, token, hash, timeoutMs) {
  if (!token) throw new NewtonError("no-token");
  return parsePerformance(
    await getJson(fetchImpl, `/api/v2/course/h/${encodeURIComponent(hash)}/self_performance/`, token, timeoutMs)
  );
}

const TITLE_KEYS = ["title", "name", "topic", "label", "assignment_title"];
const DUE_KEYS = ["due_at", "due_date", "deadline", "end_time", "ends_at", "expires_at", "due_on"];
const STATUS_KEYS = ["status", "attempt_status", "state", "attempt_state"];
const ID_KEYS = ["hash", "id", "uuid", "slug"];
const DONE_RE = /submit|solv|complet|accept|done|pass/i;

function pickKey(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? NaN : t;
  }
  return NaN;
}

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * Assignment list -> [{ id, title, dueAt, status, url, source, confidence }].
 * Tolerant: tries common key aliases, skips entries without a title or a
 * parseable due value. Throws NewtonError('shape') when the payload has no
 * recognizable list at all.
 */
export function parseAssignments(json, idPrefix = "api-assign-") {
  const raw = Array.isArray(json) ? json : asArray(json && (json.results || json.assignments || json.data));
  if (!Array.isArray(json) && !Array.isArray(json && (json.results || json.assignments || json.data))) {
    throw new NewtonError("shape");
  }
  const items = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const title = str(pickKey(e, TITLE_KEYS));
    const dueAt = toMs(pickKey(e, DUE_KEYS));
    if (!title || Number.isNaN(dueAt)) continue;
    const statusRaw = str(pickKey(e, STATUS_KEYS)).toLowerCase();
    const rawId = pickKey(e, ID_KEYS);
    const id = `${idPrefix}${djb2(`${typeof rawId === "string" || typeof rawId === "number" ? rawId : title}|${dueAt}`)}`;
    items.push({
      id,
      title,
      course: "",
      dueAt,
      status: statusRaw && DONE_RE.test(statusRaw) ? "submitted" : "pending",
      url: "",
      source: "auto-api",
      confidence: "medium",
    });
  }
  return items;
}

const ASSIGN_PAGE_LIMIT = 50;
const ASSIGN_MAX_PAGES = 5;

async function fetchPaged(fetchImpl, token, pathFn, parseFn, limit, timeoutMs) {
  const seen = new Map();
  for (let page = 0; page < ASSIGN_MAX_PAGES; page++) {
    const items = parseFn(await getJson(fetchImpl, pathFn(limit, page * limit), token, timeoutMs));
    for (const item of items) seen.set(item.id, item);
    if (items.length < limit) break;
  }
  return [...seen.values()];
}

export async function fetchAssignments(fetchImpl, token, courseHash, limit = ASSIGN_PAGE_LIMIT, timeoutMs) {
  if (!token) throw new NewtonError("no-token");
  if (!courseHash) throw new NewtonError("no-course");
  const h = encodeURIComponent(courseHash);
  return fetchPaged(
    fetchImpl,
    token,
    (l, o) => `/api/v2/course/h/${h}/assignment/all/?limit=${l}&offset=${o}`,
    parseAssignments,
    limit,
    timeoutMs
  );
}

const START_KEYS = ["start_at", "start_time", "begins_at", "starts_on", "conducted_at", ...DUE_KEYS];
const END_KEYS = ["end_at", "end_time", "ends_at", ...DUE_KEYS];

/**
 * Contest list -> [{ id, title, startsAt, endsAt, url, source, confidence }].
 * Accepts assessment-shaped (start/end) and assignment-shaped (due-only;
 * endsAt defaults to startsAt + 3h) entries. Skips title-less or dateless
 * entries; throws NewtonError('shape') on unrecognizable payloads.
 */
export function parseContests(json) {
  const raw = Array.isArray(json) ? json : asArray(json && (json.results || json.contests || json.assessments || json.data));
  if (!Array.isArray(json) && !Array.isArray(json && (json.results || json.contests || json.assessments || json.data))) {
    throw new NewtonError("shape");
  }
  const items = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const title = str(pickKey(e, TITLE_KEYS));
    const startsAt = toMs(pickKey(e, START_KEYS));
    if (!title || Number.isNaN(startsAt)) continue;
    const endRaw = toMs(pickKey(e, END_KEYS));
    const endsAt = Number.isNaN(endRaw) || endRaw <= startsAt ? startsAt + 3 * 3600000 : endRaw;
    const rawId = pickKey(e, ID_KEYS);
    items.push({
      id: `api-contest-${djb2(`${typeof rawId === "string" || typeof rawId === "number" ? rawId : title}|${startsAt}`)}`,
      title,
      startsAt,
      endsAt,
      url: "",
      source: "auto-api",
      confidence: "medium",
    });
  }
  return items;
}

export async function fetchContests(fetchImpl, token, courseHash, limit = ASSIGN_PAGE_LIMIT, timeoutMs) {
  if (!token) throw new NewtonError("no-token");
  if (!courseHash) throw new NewtonError("no-course");
  const h = encodeURIComponent(courseHash);
  const [fromAssign, fromAssess] = await Promise.all([
    fetchPaged(
      fetchImpl,
      token,
      (l, o) => `/api/v2/course/h/${h}/assignment/all/?limit=${l}&offset=${o}&is_contest=true`,
      parseContests,
      limit,
      timeoutMs
    ),
    fetchPaged(
      fetchImpl,
      token,
      (l, o) => `/api/v2/course/h/${h}/assessment/all/?limit=${l}&offset=${o}&is_contest=true&sub_types=`,
      parseContests,
      limit,
      timeoutMs
    ),
  ]);
  const seen = new Map();
  for (const item of [...fromAssign, ...fromAssess]) {
    if (!seen.has(item.id)) seen.set(item.id, item);
  }
  return [...seen.values()];
}

/** Non-contest assessments (quizzes), mapped as deadline items with quiz ids. */
export async function fetchQuizzes(fetchImpl, token, courseHash, limit = ASSIGN_PAGE_LIMIT, timeoutMs) {
  if (!token) throw new NewtonError("no-token");
  if (!courseHash) throw new NewtonError("no-course");
  const h = encodeURIComponent(courseHash);
  return fetchPaged(
    fetchImpl,
    token,
    (l, o) => `/api/v2/course/h/${h}/assessment/all/?limit=${l}&offset=${o}&attempt_statuses=&filter_topic_slugs=&sub_types=`,
    (json) => parseAssignments(json, "api-quiz-"),
    limit,
    timeoutMs
  );
}

const LECTURE_START_KEYS = ["start_at", "start_time", "scheduled_at", "scheduled_on", "begins_at", "starts_on", "lecture_start", "session_start"];
const LECTURE_END_KEYS = ["end_at", "end_time", "ends_at", "lecture_end", "session_end"];
const JOIN_KEYS = ["join_url", "meeting_url", "class_url", "url", "link"];

/**
 * Lecture planner list -> [{ id, title, startsAt, joinUrl, source, confidence }].
 * Tolerant across scheduler key variants; entries without a title or a
 * parseable start are skipped. Ends default to start + 1h. Throws
 * NewtonError('shape') on unrecognizable payloads.
 */
export function parseLectures(json) {
  const raw = Array.isArray(json) ? json : asArray(json && (json.results || json.lectures || json.sessions || json.data));
  if (!Array.isArray(json) && !Array.isArray(json && (json.results || json.lectures || json.sessions || json.data))) {
    throw new NewtonError("shape");
  }
  const items = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const title = str(pickKey(e, TITLE_KEYS));
    const startsAt = toMs(pickKey(e, LECTURE_START_KEYS));
    if (!title || Number.isNaN(startsAt)) continue;
    const endRaw = toMs(pickKey(e, LECTURE_END_KEYS));
    const rawId = pickKey(e, ID_KEYS);
    const joinRaw = pickKey(e, JOIN_KEYS);
    items.push({
      id: `api-class-${djb2(`${typeof rawId === "string" || typeof rawId === "number" ? rawId : title}|${startsAt}`)}`,
      title,
      startsAt,
      endsAt: Number.isNaN(endRaw) || endRaw <= startsAt ? startsAt + 3600000 : endRaw,
      joinUrl: typeof joinRaw === "string" ? joinRaw : "",
      source: "auto-api",
      confidence: "medium",
    });
  }
  return items;
}

export async function fetchLectures(fetchImpl, token, courseHash, timeoutMs) {
  if (!token) throw new NewtonError("no-token");
  if (!courseHash) throw new NewtonError("no-course");
  const h = encodeURIComponent(courseHash);
  return parseLectures(
    await getJson(fetchImpl, `/api/v2/course/h/${h}/learning_course/all/?pagination=false`, token, timeoutMs)
  );
}

const QOTD_PATH = "/api/v1/assignment/question_of_the_day_detail/";
const QOTD_TITLE_KEYS = ["assignmentQuestionTitle", "question_title", ...TITLE_KEYS];
const QOTD_SLUG_KEYS = ["slug", "question_slug", "questionSlug"];
const QOTD_DATE_KEYS = ["date", "qotd_date", "day", "for_date", "assigned_on"];
const QOTD_TIME_LEFT_KEYS = ["timeLeftForEod", "time_left", "timeLeftMs", "time_left_ms"];
const QOTD_URL_BASE = "https://my.newtonschool.co/question-of-the-day";

function toDateStr(ms) {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function todayDateStr() {
  return toDateStr(Date.now());
}

function parseQotdSolved(e, mapping) {
  if (typeof e.solved === "boolean") return e.solved;
  if (typeof e.is_solved === "boolean") return e.is_solved;
  if (mapping !== undefined && mapping !== null) {
    if (typeof mapping === "boolean") return mapping;
    if (mapping && typeof mapping === "object") {
      if (typeof mapping.solved === "boolean") return mapping.solved;
      if (typeof mapping.is_solved === "boolean") return mapping.is_solved;
      if (typeof mapping.attempted === "boolean" && mapping.attempted === false) return false;
      const mStatus = str(pickKey(mapping, STATUS_KEYS)).toLowerCase();
      if (mStatus) return DONE_RE.test(mStatus);
      if (typeof mapping.score === "number") return mapping.score > 0;
      if (typeof mapping.marks === "number") return mapping.marks > 0;
      return true;
    }
    return true;
  }
  const statusRaw = str(pickKey(e, STATUS_KEYS)).toLowerCase();
  if (statusRaw) return DONE_RE.test(statusRaw);
  if (typeof e.attempted === "boolean") return e.attempted;
  return false;
}

/**
 * QOTD detail (v1) -> { title, slug, date, solved, url, timeLeftMs, source, confidence }.
 * Observed live shape: { assignmentQuestionTitle, slug, date (epoch ms),
 * milestoneUserQuestionMapping (null when unsolved, object when attempted),
 * timeLeftForEod (ms), rank }. Tolerant of key aliases and epoch s/ms/ISO
 * dates. Throws NewtonError('shape') when no title can be found.
 */
export function parseQotdDetail(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new NewtonError("shape");
  const e = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
  const title = str(pickKey(e, QOTD_TITLE_KEYS));
  if (!title) throw new NewtonError("shape");
  const slug = str(pickKey(e, QOTD_SLUG_KEYS));
  const dateMs = toMs(pickKey(e, QOTD_DATE_KEYS));
  const mapping = e.milestoneUserQuestionMapping ?? e.userMapping ?? e.attempt ?? e.submission;
  const solved = parseQotdSolved(e, mapping);
  const timeRaw = pickKey(e, QOTD_TIME_LEFT_KEYS);
  const timeLeftMs = typeof timeRaw === "number" && Number.isFinite(timeRaw) ? timeRaw : null;
  return {
    title,
    slug,
    date: Number.isNaN(dateMs) ? todayDateStr() : toDateStr(dateMs),
    solved,
    url: slug ? `${QOTD_URL_BASE}/${slug}` : QOTD_URL_BASE,
    timeLeftMs,
    source: "api",
    confidence: "high",
  };
}

async function getQotdJson(fetchImpl, token, timeoutMs = TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const headers = token
    ? { Authorization: `Bearer ${token}`, Accept: "application/json" }
    : { Accept: "application/json" };
  let res;
  try {
    res = await fetchImpl(BASE + QOTD_PATH, {
      headers,
      signal: ctl.signal,
      cache: "no-store",
      credentials: "omit",
    });
  } catch (err) {
    throw new NewtonError(ctl.signal.aborted ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new NewtonError("auth");
  if (!res.ok) throw new NewtonError("http", `HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (_) {
    throw new NewtonError("shape");
  }
}

/** Fetch today's QOTD. Token optional: endpoint serves anonymous, Bearer unlocks solved state. */
export async function fetchQotd(fetchImpl, token, timeoutMs) {
  return parseQotdDetail(await getQotdJson(fetchImpl, token, timeoutMs));
}
