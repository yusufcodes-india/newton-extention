import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  applyApiAssignments,
  applyApiAttendance,
  applyApiContests,
  applyApiTimetable,
  applySync,
  createInitialState,
  markLoggedOut,
  mergeById,
  normalizeState,
  validateSettings,
} from "../src/utils/storage.js";

describe("normalizeState", () => {
  it("returns full defaults for null input", () => {
    const s = normalizeState(null);
    assert.equal(s.settings.digestTime, "21:00");
    assert.equal(s.settings.attendanceThreshold, 75);
    assert.deepEqual(s.assignments, []);
    assert.deepEqual(s.meta, { lastSyncAt: 0, notifiedIds: [], loggedOut: false, refresh: null });
    assert.equal(s.authToken, null);
    assert.equal(s.courseHash, null);
    assert.equal(s.lastGoodHash, null);
  });

  it("preserves session keys and coerces loggedOut", () => {
    const s = normalizeState({ authToken: "tok", courseHash: "h1", meta: { loggedOut: 1 } });
    assert.equal(s.authToken, "tok");
    assert.equal(s.courseHash, "h1");
    assert.equal(s.lastGoodHash, null);
    assert.equal(s.meta.loggedOut, false);
    assert.deepEqual(normalizeState({ meta: { loggedOut: true } }).meta.loggedOut, true);
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

  it("never stamps lastSyncAt for unknown page types", () => {
    const next = applySync(createInitialState(), "unknown", {}, 2000);
    assert.equal(next.attendance.percent, null);
    assert.equal(next.meta.lastSyncAt, 0);
  });

  it("DEFAULT_SETTINGS matches spec defaults", () => {
    assert.deepEqual(DEFAULT_SETTINGS.assignmentLeadsMin, [1440, 60]);
    assert.equal(DEFAULT_SETTINGS.classLeadMin, 10);
    assert.equal(DEFAULT_SETTINGS.quietHours, null);
  });
});

describe("applySync replace-on-sync per page type", () => {
  const auto = (id) => ({
    id,
    title: "Auto",
    source: "auto",
    confidence: "low",
    dueAt: 5000,
    startsAt: 5000,
    endsAt: 6000,
    updatedAt: 1,
  });
  const manual = (id) => ({
    id,
    title: "Manual",
    source: "manual",
    confidence: "high",
    dueAt: 5000,
    startsAt: 5000,
    endsAt: 6000,
    updatedAt: 1,
  });

  it("assignments: replaces auto items, preserves manual, keeps confidence", () => {
    const s = createInitialState();
    s.assignments = [manual("manual-1"), auto("auto-assign-deadbeef")];
    const next = applySync(s, "assignments", {
      items: [{ ...auto("auto-assign-live1234"), title: "Fresh" }],
    }, 9000);
    const ids = next.assignments.map((a) => a.id);
    assert.ok(ids.includes("manual-1"));
    assert.ok(ids.includes("auto-assign-live1234"));
    assert.ok(!ids.includes("auto-assign-deadbeef"));
    assert.equal(next.assignments.find((a) => a.id === "manual-1").confidence, "high");
    assert.equal(next.assignments.find((a) => a.id === "auto-assign-live1234").confidence, "low");
    assert.equal(next.assignments.find((a) => a.id === "auto-assign-live1234").source, "auto");
    assert.equal(next.meta.lastSyncAt, 9000);
  });

  it("contest: replaces auto contests, preserves manual ones", () => {
    const s = createInitialState();
    s.contests = [manual("manual-c1"), auto("auto-contest-old")];
    const next = applySync(s, "contest", {
      items: [{ ...auto("auto-contest-new"), title: "New contest" }],
    }, 9000);
    const ids = next.contests.map((c) => c.id);
    assert.deepEqual(ids.sort(), ["auto-contest-new", "manual-c1"].sort());
    assert.equal(next.meta.lastSyncAt, 9000);
  });

  it("schedule: replaces auto classes, preserves manual ones", () => {
    const s = createInitialState();
    s.timetable = [manual("manual-t1"), auto("auto-class-old")];
    const next = applySync(s, "schedule", {
      items: [{ ...auto("auto-class-new"), title: "New class" }],
    }, 9000);
    const ids = next.timetable.map((t) => t.id);
    assert.deepEqual(ids.sort(), ["auto-class-new", "manual-t1"].sort());
    assert.equal(next.meta.lastSyncAt, 9000);
  });

  it("qotd: stores confidence and stamps lastSyncAt", () => {
    const next = applySync(createInitialState(), "qotd", {
      qotd: { date: "2026-10-10", solved: false, streak: 1 },
      confidence: "low",
    }, 7000);
    assert.equal(next.qotd.solved, false);
    assert.equal(next.qotd.confidence, "low");
    assert.equal(next.qotd.source, "auto");
    assert.equal(next.meta.lastSyncAt, 7000);
  });

  it("empty parses leave lists and lastSyncAt untouched", () => {
    const s = createInitialState();
    s.assignments = [manual("manual-1")];
    const a = applySync(s, "assignments", { items: [], confidence: "none" }, 3000);
    assert.deepEqual(a.assignments.map((x) => x.id), ["manual-1"]);
    assert.equal(a.meta.lastSyncAt, 0);
    const b = applySync(createInitialState(), "attendance", { percent: null, confidence: "low" }, 3000);
    assert.equal(b.meta.lastSyncAt, 0);
    const c = applySync(createInitialState(), "unknown", { confidence: "none" }, 3000);
    assert.equal(c.meta.lastSyncAt, 0);
  });
});

describe("applyApiAttendance + markLoggedOut", () => {
  const api = {
    subjects: [
      { hash: "s1", title: "DSA", attended: 33, total: 40 },
      { hash: "s2", title: "DBMS", attended: 20, total: 20, stale: true },
    ],
  };

  it("writes overall math, subjects, api source, stamps sync", () => {
    const next = applyApiAttendance(createInitialState(), api, 5000);
    assert.equal(next.attendance.attended, 53);
    assert.equal(next.attendance.total, 60);
    assert.equal(next.attendance.percent, 88.3);
    assert.equal(next.attendance.source, "api");
    assert.equal(next.attendance.confidence, "high");
    assert.equal(next.attendance.subjects.length, 2);
    assert.equal(next.attendance.updatedAt, 5000);
    assert.equal(next.meta.lastSyncAt, 5000);
    assert.equal(next.meta.loggedOut, false);
  });

  it("nulls percent when nothing taught yet", () => {
    const next = applyApiAttendance(createInitialState(), { subjects: [] }, 1);
    assert.equal(next.attendance.percent, null);
    assert.equal(next.attendance.source, "api");
  });

  it("page parses never overwrite api attendance", () => {
    const s = applyApiAttendance(createInitialState(), api, 5000);
    const next = applySync(s, "attendance", { percent: 10, attended: 1, total: 10, confidence: "low" }, 6000);
    assert.equal(next.attendance.percent, 88.3);
    assert.equal(next.attendance.source, "api");
    assert.equal(next.meta.lastSyncAt, 5000);
  });

  it("high-confidence page parse still wins when no api data", () => {
    const next = applySync(createInitialState(), "attendance", {
      percent: 80, attended: 32, total: 40, confidence: "high",
    }, 1000);
    assert.equal(next.attendance.percent, 80);
    assert.equal(next.attendance.source, "page");
  });

  it("markLoggedOut flags without touching data or sync age", () => {
    const s = applyApiAttendance(createInitialState(), api, 5000);
    const next = markLoggedOut(s);
    assert.equal(next.meta.loggedOut, true);
    assert.equal(next.meta.lastSyncAt, 5000);
    assert.equal(next.attendance.percent, 88.3);
  });
});

describe("validateSettings", () => {
  it("nudge-hour 0 round-trips instead of falling back to 18", () => {
    assert.equal(validateSettings({ qotdNudgeHour: 0 }).qotdNudgeHour, 0);
    assert.equal(validateSettings({ qotdNudgeHour: "0" }).qotdNudgeHour, 0);
  });

  it("clamps ranges and falls back per spec", () => {
    assert.equal(validateSettings({}).digestTime, "21:00");
    assert.equal(validateSettings({ digestTime: "9pm" }).digestTime, "21:00");
    assert.equal(validateSettings({ digestTime: "08:30" }).digestTime, "08:30");
    assert.equal(validateSettings({ attendanceThreshold: 0 }).attendanceThreshold, 75);
    assert.equal(validateSettings({ attendanceThreshold: 100 }).attendanceThreshold, 75);
    assert.equal(validateSettings({ attendanceThreshold: 90 }).attendanceThreshold, 90);
    assert.equal(validateSettings({ classLeadMin: 0 }).classLeadMin, 10);
    assert.equal(validateSettings({ classLeadMin: 121 }).classLeadMin, 10);
    assert.equal(validateSettings({ classLeadMin: 30 }).classLeadMin, 30);
    assert.equal(validateSettings({ qotdNudgeHour: 24 }).qotdNudgeHour, 18);
    assert.equal(validateSettings({ qotdNudgeHour: "" }).qotdNudgeHour, 18);
    assert.deepEqual(validateSettings({}).assignmentLeadsMin, [1440, 60]);
  });
});

describe("applyApiAssignments", () => {
  const api = (id) => ({ id, title: "API", dueAt: 9000, status: "pending", source: "auto-api", confidence: "medium" });

  it("replaces api items, preserves manual, stamps sync", () => {
    const s = createInitialState();
    s.assignments = [
      { id: "manual-1", title: "M", source: "manual", confidence: "high", dueAt: 1, status: "pending" },
      api("api-assign-old"),
    ];
    const next = applyApiAssignments(s, [api("api-assign-new")], 7000);
    assert.deepEqual(next.assignments.map((a) => a.id).sort(), ["api-assign-new", "manual-1"]);
    assert.equal(next.meta.lastSyncAt, 7000);
  });

  it("empty api list leaves state untouched", () => {
    const s = createInitialState();
    s.assignments = [api("api-assign-old")];
    const next = applyApiAssignments(s, [], 7000);
    assert.deepEqual(next.assignments.map((a) => a.id), ["api-assign-old"]);
    assert.equal(next.meta.lastSyncAt, 0);
  });
});

describe("applyApiContests", () => {
  const api = (id) => ({ id, title: "C", startsAt: 9000, endsAt: 10000, source: "auto-api", confidence: "medium" });

  it("replaces api contests and stamps sync", () => {
    const s = createInitialState();
    s.contests = [api("api-contest-old")];
    const next = applyApiContests(s, [api("api-contest-new")], 7000);
    assert.deepEqual(next.contests.map((c) => c.id), ["api-contest-new"]);
    assert.equal(next.meta.lastSyncAt, 7000);
  });

  it("empty list leaves state untouched", () => {
    const next = applyApiContests(createInitialState(), [], 7000);
    assert.deepEqual(next.contests, []);
    assert.equal(next.meta.lastSyncAt, 0);
  });
});

describe("applyApiTimetable", () => {
  const cls = (id) => ({ id, title: "C", startsAt: 9000, source: "auto-api", confidence: "medium" });

  it("replaces api classes and stamps sync", () => {
    const s = createInitialState();
    s.timetable = [cls("api-class-old")];
    const next = applyApiTimetable(s, [cls("api-class-new")], 7000);
    assert.deepEqual(next.timetable.map((t) => t.id), ["api-class-new"]);
    assert.equal(next.meta.lastSyncAt, 7000);
  });

  it("empty list leaves state untouched", () => {
    const next = applyApiTimetable(createInitialState(), [], 7000);
    assert.deepEqual(next.timetable, []);
    assert.equal(next.meta.lastSyncAt, 0);
  });
});

describe("meta.refresh diagnostics", () => {
  it("preserves a refresh report through normalize", () => {
    const rep = { at: 1, attendance: "ok", assignments: "fetched:9", contests: "ok:2", timetable: "error:shape" };
    const s = normalizeState({ meta: { refresh: rep } });
    assert.deepEqual(s.meta.refresh, rep);
  });

  it("drops non-object refresh values", () => {
    assert.equal(normalizeState({ meta: { refresh: "junk" } }).meta.refresh, null);
  });
});
