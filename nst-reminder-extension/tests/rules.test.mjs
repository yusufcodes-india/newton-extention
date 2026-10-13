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
  pruneNotifiedIds,
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

  it("prunes notified ids older than 7 days, keeps recent and dateless", () => {
    const ids = [
      `overdue:od:${todayStr(NOW - 8 * 86400000)}`,
      `overdue:od:${todayStr(NOW - 7 * 86400000)}`,
      `overdue:od:${todayStr(NOW - 6 * 86400000)}`,
      `overdue:od:${todayStr(NOW)}`,
      "legacy-without-date",
    ];
    const kept = pruneNotifiedIds(ids, NOW);
    assert.ok(!kept.includes(ids[0]));
    assert.ok(kept.includes(ids[2]));
    assert.ok(kept.includes(ids[3]));
    assert.ok(kept.includes("legacy-without-date"));
  });
});
