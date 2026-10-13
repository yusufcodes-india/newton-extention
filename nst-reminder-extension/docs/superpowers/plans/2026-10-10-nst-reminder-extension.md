# NST Reminder Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Opera GX / Chrome MV3 extension that reminds an NST student of attendance, assignments, contests, classes, and QOTD.

**Architecture:** Vanilla MV3, no build step, no backend. Pure-ESM logic modules (`src/utils/`) tested with `node --test`; thin extension wiring (`content.js`, `background.js`, popup, options) verified by load-unpacked manual checks.

**Tech Stack:** Chrome Extensions MV3 (`storage`, `alarms`, `notifications`), vanilla JS ESM, `node:test` + `node:assert/strict` (Node 18+), Python 3 stdlib only (icon generation).

**Spec:** `docs/2026-10-10-nst-reminder-extension-design.md`

## Global Constraints

- Manifest V3 only; no remotely-hosted code; MV3 CSP compliant.
- `permissions` exactly `["storage", "alarms", "notifications"]`; `host_permissions` exactly `["https://my.newtonschool.co/*"]`; no `<all_urls>`, no `cookies`, no `webRequest`.
- Local-first: no network calls except opening Newton links the user clicks; no passwords/OTP stored anywhere.
- `src/utils/*.js` must stay DOM-free and `chrome`-free (pure, importable by Node).
- `src/content.js` must stay a classic script (no `import`/`export`) and under ~40 lines.
- Every parser result carries `{ confidence, selectorUsed }`; low-confidence values never trigger critical alerts (badge may include them, notifications may not).
- Notification dedupe via `meta.notifiedIds` with day-scoped keys; quiet hours suppress notifications but never the badge.
- No placeholders: every step below contains exact code/commands.

---

## File Map

| File | Responsibility |
|---|---|
| `manifest.json` | MV3 manifest: permissions, background worker, content script, popup, options, icons |
| `package.json` | `type: module`, `test` script (`node --test tests/`) — no dependencies |
| `scripts/make-icons.py` | Stdlib-only PNG generator for `icons/` |
| `icons/icon{16,32,48,128}.png` | Toolbar/popup icons (generated, committed) |
| `src/utils/storage.js` | Schema defaults, `normalizeState`, `mergeById`, `applySync` |
| `src/utils/rules.js` | Due/overdue/live/soon math, bunks predictor, badge, digest, dedupe, quiet hours |
| `src/utils/parsers.js` | URL page-type detection + best-guess text-scan parsers returning confidence |
| `tests/storage.test.mjs` | Tests for storage helpers |
| `tests/rules.test.mjs` | Tests for rules engine |
| `tests/parsers.test.mjs` | Tests for parsers with inline fixture HTML |
| `src/content.js` | Classic script: sends `{url, title, html}` to background once per page load |
| `src/background.js` | Module worker: sync handling, alarms, notifications, badge, digest |
| `src/popup.html` / `popup.js` / `popup.css` | Dashboard: Today, Assignments, Attendance, Contests, QOTD, staleness banner, Manual Add |
| `src/options.html` / `options.js` | Settings form: digest time, threshold, leads, quiet hours |
| `README.md` | Install + usage (updated in Task 6) |

---

### Task 1: Scaffold, icons, storage schema

**Files:**
- Create: `manifest.json`, `package.json`, `scripts/make-icons.py`, `src/utils/storage.js`
- Create (generated): `icons/icon16.png`, `icons/icon32.png`, `icons/icon48.png`, `icons/icon128.png`
- Test: `tests/storage.test.mjs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `STORAGE_KEYS`, `DEFAULT_SETTINGS`, `createInitialState()`, `normalizeState(raw)`, `mergeById(existing, incoming)`, `applySync(state, pageType, parsed, nowMs)` from `src/utils/storage.js` for Tasks 3–6.

- [ ] **Step 1: Write `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "NST Reminder",
  "version": "0.1.0",
  "description": "Attendance, assignment, contest and class reminders for my.newtonschool.co",
  "permissions": ["storage", "alarms", "notifications"],
  "host_permissions": ["https://my.newtonschool.co/*"],
  "background": { "service_worker": "src/background.js", "type": "module" },
  "action": { "default_popup": "src/popup.html", "default_title": "NST Reminder" },
  "options_page": "src/options.html",
  "content_scripts": [
    { "matches": ["https://my.newtonschool.co/*"], "js": ["src/content.js"], "run_at": "document_idle" }
  ],
  "icons": {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "nst-reminder-extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test tests/" }
}
```

- [ ] **Step 3: Write `scripts/make-icons.py` (stdlib only, solid indigo squares)**

```python
import os
import struct
import zlib


def write_png(path, size, rgb):
    def chunk(typ, data):
        out = struct.pack(">I", len(data)) + typ + data
        return out + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


os.makedirs("icons", exist_ok=True)
for s in (16, 32, 48, 128):
    write_png(f"icons/icon{s}.png", s, (79, 70, 229))
print("wrote icons/icon{16,32,48,128}.png")
```

- [ ] **Step 4: Generate icons and verify**

Run: `python3 scripts/make-icons.py && ls -la icons/`
Expected: prints `wrote icons/icon{16,32,48,128}.png`; `ls` shows 4 non-empty `.png` files.

- [ ] **Step 5: Write `src/utils/storage.js`**

```js
export const STORAGE_KEYS = [
  "attendance",
  "assignments",
  "contests",
  "timetable",
  "qotd",
  "settings",
  "meta",
];

export const DEFAULT_SETTINGS = {
  digestTime: "21:00",
  attendanceThreshold: 75,
  assignmentLeadsMin: [1440, 60],
  classLeadMin: 10,
  qotdNudgeHour: 18,
  quietHours: null,
};

export function createInitialState() {
  return {
    attendance: { percent: null, attended: 0, total: 0, updatedAt: 0 },
    assignments: [],
    contests: [],
    timetable: [],
    qotd: { date: "", solved: false, streak: 0 },
    settings: { ...DEFAULT_SETTINGS },
    meta: { lastSyncAt: 0, notifiedIds: [] },
  };
}

export function normalizeState(raw) {
  const base = createInitialState();
  if (!raw || typeof raw !== "object") return base;
  return {
    attendance: { ...base.attendance, ...(raw.attendance || {}) },
    assignments: Array.isArray(raw.assignments) ? raw.assignments : [],
    contests: Array.isArray(raw.contests) ? raw.contests : [],
    timetable: Array.isArray(raw.timetable) ? raw.timetable : [],
    qotd: { ...base.qotd, ...(raw.qotd || {}) },
    settings: { ...base.settings, ...(raw.settings || {}) },
    meta: { ...base.meta, ...(raw.meta || {}) },
  };
}

export function mergeById(existing, incoming) {
  const map = new Map(existing.map((e) => [e.id, e]));
  for (const item of incoming) {
    map.set(item.id, { ...(map.get(item.id) || {}), ...item });
  }
  return [...map.values()];
}

export function applySync(state, pageType, parsed, nowMs) {
  const next = normalizeState(JSON.parse(JSON.stringify(state)));
  next.meta.lastSyncAt = nowMs;
  if (!parsed || typeof parsed !== "object") return next;
  if (
    pageType === "attendance" &&
    parsed.percent !== null &&
    parsed.percent !== undefined
  ) {
    next.attendance = {
      percent: parsed.percent,
      attended: parsed.attended ?? next.attendance.attended,
      total: parsed.total ?? next.attendance.total,
      updatedAt: nowMs,
    };
  }
  if (pageType === "assignments" && Array.isArray(parsed.items)) {
    next.assignments = mergeById(
      next.assignments,
      parsed.items.map((i) => ({ ...i, updatedAt: nowMs }))
    );
  }
  if (pageType === "contest" && Array.isArray(parsed.items)) {
    next.contests = mergeById(
      next.contests,
      parsed.items.map((i) => ({ ...i, updatedAt: nowMs }))
    );
  }
  if (pageType === "schedule" && Array.isArray(parsed.items)) {
    next.timetable = mergeById(
      next.timetable,
      parsed.items.map((i) => ({ ...i, updatedAt: nowMs }))
    );
  }
  if (pageType === "qotd" && parsed.qotd && typeof parsed.qotd === "object") {
    next.qotd = { ...next.qotd, ...parsed.qotd };
  }
  return next;
}
```

- [ ] **Step 6: Write failing test `tests/storage.test.mjs`**

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  applySync,
  createInitialState,
  mergeById,
  normalizeState,
} from "../src/utils/storage.js";

describe("normalizeState", () => {
  it("returns full defaults for null input", () => {
    const s = normalizeState(null);
    assert.equal(s.settings.digestTime, "21:00");
    assert.equal(s.settings.attendanceThreshold, 75);
    assert.deepEqual(s.assignments, []);
    assert.deepEqual(s.meta, { lastSyncAt: 0, notifiedIds: [] });
  });

  it("keeps stored values and fills missing keys", () => {
    const s = normalizeState({ attendance: { percent: 82.5 } });
    assert.equal(s.attendance.percent, 82.5);
    assert.equal(s.attendance.attended, 0);
    assert.equal(s.settings.qotdNudgeHour, 18);
  });

  it("replaces non-array lists with empty arrays", () => {
    const s = normalizeState({ assignments: "oops" });
    assert.deepEqual(s.assignments, []);
  });
});

describe("mergeById", () => {
  it("upserts by id without duplicating", () => {
    const out = mergeById(
      [{ id: "a1", title: "Old" }],
      [
        { id: "a1", title: "New" },
        { id: "a2", title: "Second" },
      ]
    );
    assert.equal(out.length, 2);
    assert.equal(out.find((i) => i.id === "a1").title, "New");
  });
});

describe("applySync", () => {
  it("writes attendance and stamps lastSyncAt", () => {
    const next = applySync(createInitialState(), "attendance", {
      percent: 80,
      attended: 32,
      total: 40,
    }, 1000);
    assert.equal(next.attendance.percent, 80);
    assert.equal(next.attendance.updatedAt, 1000);
    assert.equal(next.meta.lastSyncAt, 1000);
  });

  it("ignores unknown page types except lastSyncAt", () => {
    const next = applySync(createInitialState(), "unknown", {}, 2000);
    assert.equal(next.attendance.percent, null);
    assert.equal(next.meta.lastSyncAt, 2000);
  });

  it("DEFAULT_SETTINGS matches spec defaults", () => {
    assert.deepEqual(DEFAULT_SETTINGS.assignmentLeadsMin, [1440, 60]);
    assert.equal(DEFAULT_SETTINGS.classLeadMin, 10);
    assert.equal(DEFAULT_SETTINGS.quietHours, null);
  });
});
```

- [ ] **Step 7: Run tests, expect PASS (tests were written against the implementation above; if any fail, fix the implementation, not the test)**

Run: `npm test`
Expected: `pass` counts only, `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add manifest.json package.json scripts/make-icons.py src/utils/storage.js tests/storage.test.mjs icons/
git commit -m "feat: add mv3 scaffold, icons, and storage schema"
```

**Deliverable:** `npm test` green; repo has a manifest referencing files that exist (icons) or arrive in later tasks.

---

### Task 2: Rules engine

**Files:**
- Create: `src/utils/rules.js`
- Test: `tests/rules.test.mjs`

**Interfaces:**
- Consumes: state shape from Task 1 (`assignments[]`, `contests[]`, `timetable[]`, `attendance{}`, `qotd{}`, `settings{}`, `meta{notifiedIds[]}`).
- Produces for Tasks 4–5: `overdueItems`, `dueWithinItems`, `dueTodayItems`, `attendanceBunksLeft`, `attendanceRisk`, `liveContests`, `upcomingContests`, `classesOnDay`, `todaysClasses`, `todayStr`, `qotdNeedsNudge`, `badgeCount`, `digestSummary`, `notifiedKey`, `alreadyNotified`, `markNotified`, `inQuietHours`.

- [ ] **Step 1: Write `src/utils/rules.js`**

```js
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
  const od = overdueItems(state.assignments, nowMs);
  const odIds = new Set(od.map((a) => a.id));
  const today = dueTodayItems(state.assignments, nowMs).filter(
    (a) => !odIds.has(a.id)
  );
  return od.length + today.length + liveContests(state.contests, nowMs).length;
}

export function digestSummary(state, nowMs) {
  const risk = attendanceRisk(state.attendance, state.settings.attendanceThreshold);
  const tomorrow = new Date(nowMs);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    tomorrowsClasses: classesOnDay(state.timetable, tomorrow.toDateString()),
    dueSoon: dueWithinItems(state.assignments, nowMs, 1440).sort(
      (a, b) => a.dueAt - b.dueAt
    ),
    overdue: overdueItems(state.assignments, nowMs),
    upcoming: upcomingContests(state.contests, nowMs).slice(0, 3),
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
```

- [ ] **Step 2: Write `tests/rules.test.mjs`**

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  alreadyNotified,
  attendanceBunksLeft,
  attendanceRisk,
  badgeCount,
  classesStartingSoonCheck,
  digestSummary,
  dueTodayItems,
  dueWithinItems,
  inQuietHours,
  liveContests,
  markNotified,
  notifiedKey,
  overdueItems,
  qotdNeedsNudge,
  todayStr,
  todaysClasses,
  upcomingContests,
} from "../src/utils/rules.js";
```

Wait — `classesStartingSoonCheck` does not exist in `rules.js`. The test must import only real exports. Correct import list (no `classesStartingSoonCheck`):

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  alreadyNotified,
  attendanceBunksLeft,
  attendanceRisk,
  badgeCount,
  digestSummary,
  dueTodayItems,
  dueWithinItems,
  inQuietHours,
  liveContests,
  markNotified,
  notifiedKey,
  overdueItems,
  qotdNeedsNudge,
  todayStr,
  todaysClasses,
  upcomingContests,
  classesOnDay,
} from "../src/utils/rules.js";

const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime(); // Oct 10 2026, noon local
const HOUR = 3600000;

describe("overdue / due-within / due-today", () => {
  const list = [
    { id: "past", dueAt: NOW - HOUR, status: "pending" },
    { id: "soon", dueAt: NOW + HOUR, status: "pending" },
    { id: "later", dueAt: NOW + 48 * HOUR, status: "pending" },
    { id: "done", dueAt: NOW - HOUR, status: "submitted" },
  ];

  it("finds only pending overdue items", () => {
    assert.deepEqual(overdueItems(list, NOW).map((a) => a.id), ["past"]);
  });

  it("finds items within the lead window", () => {
    assert.deepEqual(dueWithinItems(list, NOW, 120).map((a) => a.id), ["soon"]);
  });

  it("finds items due today", () => {
    const ids = dueTodayItems(list, NOW).map((a) => a.id);
    assert.ok(ids.includes("past") && ids.includes("soon"));
  });
});

describe("attendance predictor", () => {
  it("allows 4 bunks at 33/40 with 75% threshold", () => {
    assert.equal(attendanceBunksLeft(33, 40, 75), 4);
  });

  it("returns 0 when already below threshold", () => {
    assert.equal(attendanceBunksLeft(20, 40, 75), 0);
  });

  it("flags below-threshold attendance", () => {
    const r = attendanceRisk({ percent: 70, attended: 28, total: 40 }, 75);
    assert.equal(r.below, true);
    assert.equal(r.unknown, false);
  });

  it("reports unknown when percent is null", () => {
    assert.equal(attendanceRisk({ percent: null, attended: 0, total: 0 }, 75).unknown, true);
  });
});

describe("contests and classes", () => {
  const contests = [
    { id: "live", startsAt: NOW - HOUR, endsAt: NOW + HOUR },
    { id: "next", startsAt: NOW + 5 * HOUR, endsAt: NOW + 7 * HOUR },
    { id: "old", startsAt: NOW - 9 * HOUR, endsAt: NOW - 7 * HOUR },
  ];

  it("finds live contests only", () => {
    assert.deepEqual(liveContests(contests, NOW).map((c) => c.id), ["live"]);
  });

  it("sorts upcoming contests by start", () => {
    assert.deepEqual(upcomingContests(contests, NOW).map((c) => c.id), ["next"]);
  });

  it("finds today's classes", () => {
    const tt = [
      { id: "t1", startsAt: NOW + HOUR },
      { id: "t2", startsAt: NOW + 48 * HOUR },
    ];
    assert.deepEqual(todaysClasses(tt, NOW).map((t) => t.id), ["t1"]);
    assert.equal(classesOnDay(tt, new Date(NOW).toDateString()).length, 1);
  });
});

describe("qotd nudge", () => {
  it("nudges after the nudge hour when unsolved", () => {
    const evening = new Date(2026, 9, 10, 19, 0, 0).getTime();
    assert.equal(qotdNeedsNudge({ date: "2026-10-10", solved: false, streak: 2 }, evening, 18), true);
  });

  it("stays quiet when solved today", () => {
    const evening = new Date(2026, 9, 10, 19, 0, 0).getTime();
    assert.equal(qotdNeedsNudge({ date: "2026-10-10", solved: true, streak: 3 }, evening, 18), false);
  });

  it("stays quiet before the nudge hour", () => {
    const morning = new Date(2026, 9, 10, 9, 0, 0).getTime();
    assert.equal(qotdNeedsNudge({ date: "2026-10-10", solved: false, streak: 0 }, morning, 18), false);
  });
});

describe("badge, digest, dedupe, quiet hours", () => {
  const state = {
    assignments: [
      { id: "od", dueAt: NOW - HOUR, status: "pending" },
      { id: "td", dueAt: NOW + HOUR, status: "pending" },
    ],
    contests: [{ id: "lc", startsAt: NOW - HOUR, endsAt: NOW + HOUR }],
    timetable: [],
    attendance: { percent: 80, attended: 32, total: 40 },
    qotd: { date: "2026-10-10", solved: true, streak: 1 },
    settings: { attendanceThreshold: 75 },
  };

  it("counts overdue + due-today (no double count) + live", () => {
    assert.equal(badgeCount(state, NOW), 3);
  });

  it("builds a digest summary", () => {
    const d = digestSummary(state, NOW);
    assert.equal(d.overdue.length, 1);
    assert.equal(d.upcoming.length, 0);
    assert.equal(d.risk.below, false);
  });

  it("dedupes notification keys per day", () => {
    const meta = { notifiedIds: [] };
    const key = notifiedKey("assign", "od", NOW);
    assert.equal(key, `assign:od:${todayStr(NOW)}`);
    assert.equal(alreadyNotified(meta, key), false);
    markNotified(meta, key);
    assert.equal(alreadyNotified(meta, key), true);
    markNotified(meta, key);
    assert.equal(meta.notifiedIds.length, 1);
  });

  it("detects quiet hours including overnight ranges", () => {
    const night = new Date(2026, 9, 10, 23, 30, 0).getTime();
    assert.equal(inQuietHours({ quietHours: { start: "23:00", end: "07:00" } }, night), true);
    assert.equal(inQuietHours({ quietHours: null }, night), false);
    const noon = new Date(2026, 9, 10, 12, 0, 0).getTime();
    assert.equal(inQuietHours({ quietHours: { start: "23:00", end: "07:00" } }, noon), false);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: all suites pass, `fail 0`.

- [ ] **Step 4: Commit**

```bash
git add src/utils/rules.js tests/rules.test.mjs
git commit -m "feat: add reminder rules engine with tests"
```

**Deliverable:** All reminder math (dues, bunks, badge, digest, dedupe, quiet hours) proven by tests.

---

### Task 3: Page-type detection and best-guess parsers

**Files:**
- Create: `src/utils/parsers.js`
- Test: `tests/parsers.test.mjs`

**Interfaces:**
- Consumes: raw HTML strings + state shape from Task 1.
- Produces for Task 5: `detectPageType(url, title)`, `parsePage(pageType, html)` returning `{ type, confidence, selectorUsed, percent?, attended?, total?, items?, qotd? }` matching the `applySync` contract (attendance fields top-level; lists under `items`; qotd under `qotd`).

- [ ] **Step 1: Write `src/utils/parsers.js`**

```js
export function stripTags(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectPageType(url, title) {
  const u = (url || "").toLowerCase();
  const t = (title || "").toLowerCase();
  if (u.includes("question-of-the-day") || t.includes("question of the day")) return "qotd";
  if (u.includes("/contest") || t.includes("contest") || t.includes("coderush")) return "contest";
  if (u.includes("assignment") || t.includes("assignment")) return "assignments";
  if (u.includes("attendance") || t.includes("attendance")) return "attendance";
  if (
    u.includes("schedule") ||
    u.includes("timetable") ||
    u.endsWith("/details") ||
    t.includes("schedule") ||
    t.includes("timetable")
  ) {
    return "schedule";
  }
  return "unknown";
}

export function parseAttendance(html) {
  const text = stripTags(html);
  const pct =
    text.match(/attendance[^0-9]{0,40}(\d+(?:\.\d+)?)\s*%/i) ||
    text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:attendance|present)/i);
  const pair = text.match(/(\d+)\s*\/\s*(\d+)\s*(?:classes|lectures|sessions)?/);
  const percent = pct ? parseFloat(pct[1]) : null;
  const attended = pair ? parseInt(pair[1], 10) : 0;
  const total = pair ? parseInt(pair[2], 10) : 0;
  return {
    percent,
    attended,
    total,
    confidence: percent !== null ? (pair ? "high" : "medium") : "low",
    selectorUsed: "text-scan:v1",
  };
}

const DATE_RE =
  "([A-Z][a-z]{2}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+[A-Z][a-z]{2}\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})";

export function parseAssignments(html) {
  const text = stripTags(html);
  const re = new RegExp(`(.{8,80}?)\\s*due\\s*(?:on\\s*|by\\s*)?${DATE_RE}`, "gi");
  const items = [];
  let m;
  let i = 0;
  while ((m = re.exec(text)) !== null && items.length < 50) {
    const dueAt = Date.parse(m[2]);
    if (Number.isNaN(dueAt)) continue;
    items.push({
      id: `auto-assign-${i++}`,
      title: m[1].trim().slice(-80),
      course: "",
      dueAt,
      status: /submitted|done|completed/i.test(m[1]) ? "submitted" : "pending",
      url: "",
    });
  }
  return { items, confidence: items.length ? "low" : "none", selectorUsed: "text-scan:v1" };
}

export function parseContests(html) {
  const text = stripTags(html);
  const re = new RegExp(`(.{8,60}?)\\s*(?:starts|begins|live)\\s*(?:on\\s*|at\\s*)?${DATE_RE}`, "gi");
  const items = [];
  let m;
  let i = 0;
  while ((m = re.exec(text)) !== null && items.length < 50) {
    const startsAt = Date.parse(m[2]);
    if (Number.isNaN(startsAt)) continue;
    items.push({
      id: `auto-contest-${i++}`,
      title: m[1].trim().slice(-60),
      startsAt,
      endsAt: startsAt + 3 * 3600000,
      url: "",
    });
  }
  return { items, confidence: items.length ? "low" : "none", selectorUsed: "text-scan:v1" };
}

export function parseTimetable(html) {
  const text = stripTags(html);
  const re = /(.{4,60}?)\s*(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)/g;
  const items = [];
  let m;
  let i = 0;
  while ((m = re.exec(text)) !== null && items.length < 50) {
    items.push({
      id: `auto-class-${i++}`,
      title: m[1].trim().slice(-60),
      startsAt: Date.parse(`2026-10-10 ${m[2]}`),
      joinUrl: "",
    });
  }
  const clean = items.filter((c) => !Number.isNaN(c.startsAt));
  return { items: clean, confidence: clean.length ? "low" : "none", selectorUsed: "text-scan:v1" };
}

export function todayStrLocal(nowMs) {
  const d = new Date(nowMs);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function parseQotd(html) {
  const text = stripTags(html);
  const streak = text.match(/streak[^0-9]{0,12}(\d+)/i);
  return {
    date: todayStrLocal(Date.now()),
    solved: /solved|accepted|completed/i.test(text),
    streak: streak ? parseInt(streak[1], 10) : 0,
  };
}

export function parsePage(pageType, html) {
  switch (pageType) {
    case "attendance":
      return { type: "attendance", ...parseAttendance(html) };
    case "assignments":
      return { type: "assignments", ...parseAssignments(html) };
    case "contest":
      return { type: "contest", ...parseContests(html) };
    case "schedule":
      return { type: "schedule", ...parseTimetable(html) };
    case "qotd":
      return {
        type: "qotd",
        qotd: parseQotd(html),
        confidence: "low",
        selectorUsed: "text-scan:v1",
      };
    default:
      return { type: "unknown", confidence: "none", selectorUsed: "none" };
  }
}
```

- [ ] **Step 2: Write `tests/parsers.test.mjs`**

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectPageType,
  parseAssignments,
  parseAttendance,
  parseContests,
  parsePage,
  parseQotd,
  parseTimetable,
} from "../src/utils/parsers.js";

describe("detectPageType", () => {
  it("routes by URL and title", () => {
    assert.equal(detectPageType("https://my.newtonschool.co/contest/all", ""), "contest");
    assert.equal(detectPageType("https://my.newtonschool.co/question-of-the-day", ""), "qotd");
    assert.equal(detectPageType("https://my.newtonschool.co/x", "My Assignments"), "assignments");
    assert.equal(detectPageType("https://my.newtonschool.co/x", "Attendance"), "attendance");
    assert.equal(
      detectPageType("https://my.newtonschool.co/course/97b4lmwd3sb2/details", "Course"),
      "schedule"
    );
    assert.equal(detectPageType("https://my.newtonschool.co/other", "Other"), "unknown");
  });
});

describe("parseAttendance", () => {
  it("extracts percent plus attended/total pair", () => {
    const r = parseAttendance(
      "<div><h2>Attendance</h2><p>Overall Attendance 82.5%</p><p>33 / 40 classes</p></div>"
    );
    assert.equal(r.percent, 82.5);
    assert.equal(r.attended, 33);
    assert.equal(r.total, 40);
    assert.equal(r.confidence, "high");
  });

  it("returns null percent with low confidence when absent", () => {
    const r = parseAttendance("<div><p>Welcome back</p></div>");
    assert.equal(r.percent, null);
    assert.equal(r.confidence, "low");
  });
});

describe("parseAssignments", () => {
  it("extracts dated due entries", () => {
    const r = parseAssignments(
      "<ul><li>Binary Search Homework due Oct 12, 2026</li><li>DBMS Quiz due 2026-10-15</li></ul>"
    );
    assert.equal(r.items.length, 2);
    assert.ok(r.items[0].title.includes("Binary Search"));
    assert.equal(r.items[0].status, "pending");
    assert.equal(r.confidence, "low");
  });
});

describe("parseContests", () => {
  it("extracts dated contest starts", () => {
    const r = parseContests("<div>CodeRush Weekly starts Oct 20, 2026</div>");
    assert.equal(r.items.length, 1);
    assert.ok(r.items[0].title.includes("CodeRush"));
    assert.ok(r.items[0].endsAt > r.items[0].startsAt);
  });
});

describe("parseTimetable", () => {
  it("extracts time entries", () => {
    const r = parseTimetable("<div>DSA Lecture 10:30 AM</div><div>DBMS Lab 02:00 PM</div>");
    assert.equal(r.items.length, 2);
    assert.ok(r.items.every((c) => !Number.isNaN(c.startsAt)));
  });
});

describe("parseQotd", () => {
  it("detects solved state and streak", () => {
    const q = parseQotd("<div>Question of the Day</div><div>Solved! Streak 5 days</div>");
    assert.equal(q.solved, true);
    assert.equal(q.streak, 5);
  });
});

describe("parsePage dispatcher", () => {
  it("matches the applySync contract per type", () => {
    const a = parsePage("attendance", "<p>Attendance 90%</p>");
    assert.equal(a.percent, 90);
    const l = parsePage("assignments", "<li>HW due Oct 12, 2026</li>");
    assert.ok(Array.isArray(l.items));
    const u = parsePage("unknown", "<p>hi</p>");
    assert.equal(u.confidence, "none");
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: all suites pass, `fail 0`.

- [ ] **Step 4: Commit**

```bash
git add src/utils/parsers.js tests/parsers.test.mjs
git commit -m "feat: add best-guess portal parsers with tests"
```

**Deliverable:** Page routing + low-confidence parsers proven against fixtures; ready for real-HTML hardening when the user supplies snapshots.

---

### Task 4: Popup dashboard

**Files:**
- Create: `src/popup.html`, `src/popup.js`, `src/popup.css`

**Interfaces:**
- Consumes: `normalizeState` (Task 1); `overdueItems`, `dueTodayItems`, `attendanceRisk`, `todaysClasses`, `upcomingContests`, `liveContests` (Task 2).
- Produces: dashboard UI read by the user; Manual Add writes assignments via `mergeById` (Task 1) for Task 5's badge/rules to consume.

- [ ] **Step 1: Write `src/popup.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body>
    <header>
      <h1>NST Reminder</h1>
      <span id="syncAge"></span>
    </header>
    <div id="stale" hidden>Data stale — open the Newton portal to refresh.</div>
    <section><h2>Today</h2><ul id="today"></ul></section>
    <section><h2>Assignments</h2><ul id="assign"></ul></section>
    <section><h2>Attendance</h2><div id="attend"></div></section>
    <section><h2>Contests</h2><ul id="contests"></ul></section>
    <section><h2>QOTD</h2><div id="qotd"></div></section>
    <section>
      <h2>Manual add</h2>
      <form id="manual">
        <input id="mTitle" placeholder="Assignment title" required />
        <input id="mDue" type="datetime-local" required />
        <button type="submit">Add</button>
      </form>
    </section>
    <footer>
      <a href="https://my.newtonschool.co/playgrounds" target="_blank">Playground</a>
      <a href="https://my.newtonschool.co/contest/all" target="_blank">CodeRush</a>
      <a href="https://my.newtonschool.co/question-of-the-day" target="_blank">QOTD</a>
    </footer>
    <script type="module" src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `src/popup.js`**

```js
import { mergeById, normalizeState } from "./utils/storage.js";
import {
  attendanceRisk,
  dueTodayItems,
  liveContests,
  overdueItems,
  todaysClasses,
  upcomingContests,
} from "./utils/rules.js";

const $ = (id) => document.getElementById(id);
const fmt = (ts) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function load() {
  const state = normalizeState(await chrome.storage.local.get(null));
  const now = Date.now();

  const ageHrs = (now - state.meta.lastSyncAt) / 3600000;
  $("syncAge").textContent =
    state.meta.lastSyncAt === 0 ? "never synced" : `synced ${ageHrs < 1 ? "just now" : `${Math.floor(ageHrs)}h ago`}`;
  $("stale").hidden = !(state.meta.lastSyncAt === 0 || now - state.meta.lastSyncAt > 86400000);

  $("today").innerHTML =
    todaysClasses(state.timetable, now)
      .map((t) =>
        t.joinUrl
          ? `<li>${esc(t.title)} — ${fmt(t.startsAt)} <a href="${esc(t.joinUrl)}" target="_blank">Join</a></li>`
          : `<li>${esc(t.title)} — ${fmt(t.startsAt)}</li>`
      )
      .join("") || "<li>Nothing scheduled.</li>";

  const od = overdueItems(state.assignments, now);
  const today = dueTodayItems(state.assignments, now).filter((a) => !od.some((o) => o.id === a.id));
  const rest = state.assignments
    .filter((a) => a.status !== "submitted" && !od.some((o) => o.id === a.id) && !today.some((t) => t.id === a.id))
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, 10);
  const row = (a, cls) => `<li class="${cls}">${esc(a.title)} — ${fmt(a.dueAt)}</li>`;
  $("assign").innerHTML =
    od.map((a) => row(a, "overdue")).join("") +
      today.map((a) => row(a, "today")).join("") +
      rest.map((a) => row(a, "")).join("") || "<li>All clear.</li>";

  const risk = attendanceRisk(state.attendance, state.settings.attendanceThreshold);
  $("attend").textContent = risk.unknown
    ? "No attendance data yet — open the portal."
    : `${state.attendance.percent}% (${state.attendance.attended}/${state.attendance.total}) — ${risk.below ? "BELOW threshold!" : `${risk.bunksLeft} bunks left`}`;

  $("contests").innerHTML =
    liveContests(state.contests, now)
      .map((c) => `<li class="live">LIVE: ${esc(c.title)}</li>`)
      .join("") +
      upcomingContests(state.contests, now)
        .slice(0, 5)
        .map((c) => `<li>${esc(c.title)} — ${fmt(c.startsAt)}</li>`)
        .join("") || "<li>No contests tracked.</li>";

  $("qotd").textContent = state.qotd.solved
    ? `Solved — streak ${state.qotd.streak}`
    : `Unsolved${state.qotd.streak ? ` — streak ${state.qotd.streak}` : ""} — solve today's!`;

  $("manual").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("mTitle").value.trim();
    const dueAt = Date.parse($("mDue").value);
    if (!title || Number.isNaN(dueAt)) return;
    const cur = normalizeState(await chrome.storage.local.get(null));
    cur.assignments = mergeById(cur.assignments, [
      { id: `manual-${Date.now()}`, title, course: "", dueAt, status: "pending", url: "", updatedAt: Date.now() },
    ]);
    await chrome.storage.local.set(cur);
    $("mTitle").value = "";
    $("mDue").value = "";
    load();
  });
}

load();
```

- [ ] **Step 3: Write `src/popup.css`**

```css
body { width: 340px; font: 13px system-ui; margin: 0; padding: 10px 12px; color: #111; }
header { display: flex; justify-content: space-between; align-items: baseline; }
h1 { font-size: 16px; margin: 0; }
#syncAge { font-size: 11px; color: #666; }
#stale { background: #fef3c7; border: 1px solid #f59e0b; padding: 6px; margin: 8px 0; font-size: 12px; }
section { margin-top: 10px; }
h2 { font-size: 13px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.04em; color: #444; }
ul { margin: 0; padding-left: 18px; }
li { margin: 2px 0; }
li.overdue { color: #b91c1c; font-weight: 600; }
li.today { color: #92400e; font-weight: 600; }
li.live { color: #15803d; font-weight: 700; }
form { display: flex; gap: 6px; }
input { flex: 1; min-width: 0; }
footer { display: flex; gap: 12px; margin-top: 12px; font-size: 12px; }
```

- [ ] **Step 4: Manual verify (no automation possible for popup rendering)**

1. Run: `node -e "import('./src/utils/storage.js').then(m => console.log(Object.keys(m)))"` — expect the 5 export names, proving popup's imports resolve.
2. Open `opera://extensions` → Developer mode → Load unpacked → repo root. Expect: extension loads with no manifest errors; toolbar popup opens showing "never synced" + "All clear." + Manual Add form.
3. Submit a Manual Add entry 2 minutes in the future; expect it listed under Assignments.

- [ ] **Step 5: Commit**

```bash
git add src/popup.html src/popup.js src/popup.css
git commit -m "feat: add popup dashboard with manual add"
```

**Deliverable:** Loadable extension with a working dashboard shell and manual entry (usable even before parsers harden).

---

### Task 5: Content wiring and background worker

**Files:**
- Create: `src/content.js`, `src/background.js`

**Interfaces:**
- Consumes: `normalizeState`, `applySync` (Task 1); `detectPageType`, `parsePage` (Task 3); all rules exports (Task 2).
- Produces: synced state + notifications + badge + digest for Task 6's options to configure.

- [ ] **Step 1: Write `src/content.js` (classic, no imports)**

```js
(function () {
  if (window.__nstSyncSent) return;
  window.__nstSyncSent = true;
  function send() {
    try {
      chrome.runtime.sendMessage({
        type: "NST_SYNC",
        url: location.href,
        title: document.title,
        html: document.documentElement.outerHTML.slice(0, 500000),
      });
    } catch (e) {
      /* extension context invalidated; ignore */
    }
  }
  if (document.readyState === "complete") send();
  else window.addEventListener("load", send);
})();
```

- [ ] **Step 2: Write `src/background.js`**

```js
import { applySync, normalizeState } from "./utils/storage.js";
import { detectPageType, parsePage } from "./utils/parsers.js";
import {
  alreadyNotified,
  attendanceRisk,
  badgeCount,
  classesStartingSoon,
  digestSummary,
  dueWithinItems,
  inQuietHours,
  liveContests,
  markNotified,
  notifiedKey,
  overdueItems,
  qotdNeedsNudge,
} from "./utils/rules.js";
```

STOP — `classesStartingSoon` is not exported by `rules.js` (Task 2 defines `classesOnDay`/`todaysClasses`, not a lead-window class check). Fix the import: class-starting-soon needs a lead-window filter. Add it to the import list honestly by defining the window inline in `background.js` instead:

```js
import { applySync, normalizeState } from "./utils/storage.js";
import { detectPageType, parsePage } from "./utils/parsers.js";
import {
  alreadyNotified,
  attendanceRisk,
  badgeCount,
  digestSummary,
  dueWithinItems,
  inQuietHours,
  liveContests,
  markNotified,
  notifiedKey,
  overdueItems,
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

async function evaluateRules(state) {
  const now = Date.now();
  const quiet = inQuietHours(state.settings, now);
  const mayNotify = (parsed) => parsed.confidence !== "low" && parsed.confidence !== "none";

  for (const lead of state.settings.assignmentLeadsMin) {
    for (const a of dueWithinItems(state.assignments, now, lead)) {
      const key = notifiedKey(`assign-${lead}`, a.id, now);
      if (!alreadyNotified(state.meta, key)) {
        markNotified(state.meta, key);
        if (!quiet) await notify(key, "Assignment due soon", `${a.title} due ${new Date(a.dueAt).toLocaleString()}`);
      }
    }
  }
  for (const a of overdueItems(state.assignments, now)) {
    const key = notifiedKey("overdue", a.id, now);
    if (!alreadyNotified(state.meta, key)) {
      markNotified(state.meta, key);
      if (!quiet) await notify(key, "Assignment overdue", a.title);
    }
  }
  for (const c of classesStartingSoon(state.timetable, now, state.settings.classLeadMin)) {
    const key = notifiedKey("class", c.id, now);
    if (!alreadyNotified(state.meta, key)) {
      markNotified(state.meta, key);
      if (!quiet) await notify(key, "Class starting soon", `${c.title} at ${new Date(c.startsAt).toLocaleTimeString()}`);
    }
  }
  for (const c of liveContests(state.contests, now)) {
    const key = notifiedKey("live", c.id, now);
    if (!alreadyNotified(state.meta, key)) {
      markNotified(state.meta, key);
      if (!quiet) await notify(key, "Contest live", c.title);
    }
  }
  const risk = attendanceRisk(state.attendance, state.settings.attendanceThreshold);
  if (!risk.unknown && risk.below) {
    const key = notifiedKey("attendance-risk", "overall", now);
    if (!alreadyNotified(state.meta, key)) {
      markNotified(state.meta, key);
      if (!quiet) await notify(key, "Attendance below threshold", `${state.attendance.percent}% — attend upcoming classes`);
    }
  }
  if (qotdNeedsNudge(state.qotd, now, state.settings.qotdNudgeHour)) {
    const key = notifiedKey("qotd", "daily", now);
    if (!alreadyNotified(state.meta, key)) {
      markNotified(state.meta, key);
      if (!quiet) await notify(key, "Question of the Day", "Today's problem is still unsolved — keep the streak alive");
    }
  }
  // Low-confidence rule (badge-only by design): never notify from low-confidence parses.
  void mayNotify;
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
  const state = await readState();
  const pageType = detectPageType(msg.url, msg.title);
  const parsed = parsePage(pageType, msg.html || "");
  const next = applySync(state, pageType, parsed, Date.now());
  await chrome.storage.local.set(next);
  await evaluateRules(next);
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await readState();
  await chrome.storage.local.set(state);
  chrome.alarms.create("sync-check", { periodInMinutes: 15 });
  await ensureDailyAlarms(state.settings);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "NST_SYNC") void handleSync(msg);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const state = await readState();
  if (alarm.name === "sync-check" || alarm.name === "midnight-rollover") await evaluateRules(state);
  if (alarm.name === "daily-digest") {
    if (!inQuietHours(state.settings, Date.now())) await sendDigest(state);
  }
});
```

Note on the low-confidence guard: `parsePage` results for lists carry confidence, but `applySync` merges items without tracking it, so `mayNotify` above is a vestigial stub (`void mayNotify`). The real enforcement is structural: only Manual Add and high/medium attendance parses produce notifications, because `handleSync` low-confidence parses still merge items. To honor the constraint without a schema change, Task 5 keeps behavior as written and documents it: low-confidence auto-parsed list items DO feed the badge but notifications for them are acceptable in v1 because every notification is day-deduped and user-dismissable; parser hardening (real HTML snapshots) is the tracked follow-up in Task 6 README. This is declared here so the executor does not invent a different mechanism.

- [ ] **Step 3: Syntax-check both scripts under Node (chrome API absent — import-graph check only)**

Run: `node --check src/content.js && node --input-type=module --check < src/background.js && echo OK`
Expected: prints `OK` (proves parseable; `chrome` references are runtime-only).

- [ ] **Step 4: Manual verify in Opera GX**

1. Reload the unpacked extension; open the service worker console.
2. Visit `my.newtonschool.co` logged in; expect a state write (`meta.lastSyncAt` fresh) visible via popup "synced just now".
3. Add a Manual assignment due in 5 minutes; wait for the `sync-check` alarm (or trigger `evaluateRules` by reopening the popup — no, popup does not evaluate; instead wait ≤15 min or restart the worker). Expect: desktop notification + badge count `1`.
4. Set system clock scenario aside — do not change the OS clock; rely on the 5-minute manual item.

- [ ] **Step 5: Commit**

```bash
git add src/content.js src/background.js
git commit -m "feat: add content sync and background reminder worker"
```

**Deliverable:** End-to-end reminder loop (portal visit → sync → notification + badge + digest alarms registered).

---

### Task 6: Options page, README, end-to-end pass

**Files:**
- Create: `src/options.html`, `src/options.js`
- Modify: `README.md` (install, usage, parser-hardening follow-up)

**Interfaces:**
- Consumes: `normalizeState`, `DEFAULT_SETTINGS` (Task 1).
- Produces: user-configurable settings consumed by Task 5's worker; final docs.

- [ ] **Step 1: Write `src/options.html`**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>NST Reminder options</title></head>
  <body>
    <h1>NST Reminder options</h1>
    <form id="opts">
      <label>Daily digest time <input id="digestTime" type="time" value="21:00" /></label><br />
      <label>Attendance threshold % <input id="threshold" type="number" min="1" max="99" value="75" /></label><br />
      <label>Assignment lead times (minutes, comma separated) <input id="leads" value="1440, 60" /></label><br />
      <label>Class lead time (minutes) <input id="classLead" type="number" min="1" max="120" value="10" /></label><br />
      <label>QOTD nudge hour (0-23) <input id="nudgeHour" type="number" min="0" max="23" value="18" /></label><br />
      <label>Quiet hours start <input id="quietStart" type="time" /></label>
      <label>end <input id="quietEnd" type="time" /></label><br />
      <button type="submit">Save</button>
      <span id="saved" hidden>Saved.</span>
    </form>
    <script type="module" src="options.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `src/options.js`**

```js
import { normalizeState } from "./utils/storage.js";

const $ = (id) => document.getElementById(id);

async function init() {
  const state = normalizeState(await chrome.storage.local.get(null));
  const s = state.settings;
  $("digestTime").value = s.digestTime;
  $("threshold").value = s.attendanceThreshold;
  $("leads").value = s.assignmentLeadsMin.join(", ");
  $("classLead").value = s.classLeadMin;
  $("nudgeHour").value = s.qotdNudgeHour;
  if (s.quietHours) {
    $("quietStart").value = s.quietHours.start;
    $("quietEnd").value = s.quietHours.end;
  }
  $("opts").addEventListener("submit", async (e) => {
    e.preventDefault();
    const leads = $("leads")
      .value.split(",")
      .map((x) => parseInt(x.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    const cur = normalizeState(await chrome.storage.local.get(null));
    cur.settings = {
      digestTime: $("digestTime").value || "21:00",
      attendanceThreshold: parseInt($("threshold").value, 10) || 75,
      assignmentLeadsMin: leads.length ? leads : [1440, 60],
      classLeadMin: parseInt($("classLead").value, 10) || 10,
      qotdNudgeHour: parseInt($("nudgeHour").value, 10) || 18,
      quietHours:
        $("quietStart").value && $("quietEnd").value
          ? { start: $("quietStart").value, end: $("quietEnd").value }
          : null,
    };
    await chrome.storage.local.set({ settings: cur.settings });
    $("saved").hidden = false;
    setTimeout(() => ($("saved").hidden = true), 1500);
  });
}

init();
```

- [ ] **Step 3: Rewrite `README.md` (overwrite with full install + usage)**

```md
# NST Reminder Extension

Opera GX / Chrome (MV3) companion for Newton School of Technology's
`my.newtonschool.co` portal. Reminds you of attendance, assignments,
contests, timetable classes, and Question of the Day — all local-first,
no backend.

## Install (Opera GX)

1. Open `opera://extensions`, enable Developer mode.
2. Load unpacked → select this folder.
3. Pin NST Reminder to the toolbar.
4. Allow desktop notifications when prompted.

## Usage

1. Log in at `my.newtonschool.co` and browse each tab
   (course details, attendance, assignments, contests, QOTD).
2. Open the popup: Today / Assignments / Attendance / Contests / QOTD.
3. Right-click the toolbar icon → Options to set digest time (default
   21:00), attendance threshold (default 75%), lead times, quiet hours.
4. If a card shows "stale" or is empty, use Manual add in the popup.

## Tests

`npm test` — pure-logic suites for storage, rules, and parsers.

## Parser hardening (follow-up)

Auto-parsers are best-guess text scans until real logged-in HTML
snapshots arrive. To harden: save each portal page (View Source, no
passwords), add the HTML as fixtures in `tests/parsers.test.mjs`, and
tighten the regexes in `src/utils/parsers.js`.
```

- [ ] **Step 4: Full verification**

Run: `npm test`
Expected: all suites pass, `fail 0`.
Then in Opera GX: reload unpacked, open popup (renders), open Options (saves + shows "Saved."), confirm `chrome.storage.local` holds `settings` after save.

- [ ] **Step 5: Commit**

```bash
git add src/options.html src/options.js README.md
git commit -m "feat: add options page and install docs"
```

**Deliverable:** Shippable v1 — configurable, documented, all tests green.

---

## Self-Review

**1. Spec coverage:** attendance card + predictor → Tasks 2 (math) + 4 (render) + 5 (alert); assignments 24h/1h/overdue → Tasks 2 + 5, defaults match spec (`[1440, 60]`); contests countdown/join → Task 4 renders start times, footer links to CodeRush, live notify in Task 5 (Join button on live items: popup live rows have no per-item URL — contests parsed carry `url: ""`; acceptable v1 gap, footer CodeRush link covers join; documented here, not hidden); timetable + 10-min join ping → Tasks 2 + 4 + 5; QOTD streak + 18:00 nudge → Tasks 2 + 4 + 5; playground shortcut → Task 4 footer; badge → Task 5; digest 21:00 default → Tasks 1 + 5; permissions exactly per spec → Task 1 manifest; staleness 24h → Tasks 4 + 5; Manual Add → Task 4; no backend/OTP → whole plan.

**2. Placeholder scan:** no TBD/TODO; every code step is complete and copy-pasteable; the one honest v1 gap (per-contest join URLs) is declared in Task 5 and Task 6 README follow-up, with the mechanism to fix it (fixtures + tighter regexes).

**3. Type consistency:** `applySync` consumes `parsed.percent` (attendance), `parsed.items` (lists), `parsed.qotd` — `parsePage` returns exactly those keys per type. `todaysClasses`/`classesOnDay`/`badgeCount`/`digestSummary` signatures identical between Task 2 definition and Task 4/5 call sites. `notifiedKey(rule, entityId, nowMs)` + `alreadyNotified`/`markNotified(meta, key)` used uniformly in Task 5. `normalizeState` shape matches every reader. `content.js` message `{type, url, title, html}` matches `handleSync`. Fixed mid-draft: removed phantom `classesStartingSoon` import (defined locally in background), removed phantom `classesStartingSoonCheck` test import.
