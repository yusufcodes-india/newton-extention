import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, normalizeState, validateSettings } from "../src/utils/storage.js";
import { badgeCount, digestSummary, isSectionEnabled } from "../src/utils/rules.js";

const ALL_ON = { attendance: true, assignments: true, contests: true, classes: true, qotd: true };

describe("enabledSections defaults", () => {
  it("DEFAULT_SETTINGS enables every section", () => {
    assert.deepEqual(DEFAULT_SETTINGS.enabledSections, ALL_ON);
  });

  it("validateSettings defaults to all-on when absent", () => {
    assert.deepEqual(validateSettings({}).enabledSections, ALL_ON);
  });

  it("validateSettings respects explicit off switches", () => {
    const out = validateSettings({ enabledSections: { contests: false, qotd: false } });
    assert.equal(out.enabledSections.contests, false);
    assert.equal(out.enabledSections.qotd, false);
    assert.equal(out.enabledSections.attendance, true);
    assert.equal(out.enabledSections.assignments, true);
    assert.equal(out.enabledSections.classes, true);
  });

  it("validateSettings coerces garbage values to on", () => {
    const out = validateSettings({ enabledSections: { contests: "no", attendance: 0, qotd: null } });
    assert.deepEqual(out.enabledSections, ALL_ON);
  });

  it("validateSettings coerces non-object to all-on", () => {
    assert.deepEqual(validateSettings({ enabledSections: "all" }).enabledSections, ALL_ON);
  });
});

describe("enabledSections normalization", () => {
  it("normalizeState fills enabledSections for legacy stored settings", () => {
    const s = normalizeState({ settings: { digestTime: "20:00" } });
    assert.deepEqual(s.settings.enabledSections, ALL_ON);
    assert.equal(s.settings.digestTime, "20:00");
  });

  it("normalizeState preserves stored off switches", () => {
    const s = normalizeState({ settings: { enabledSections: { contests: false } } });
    assert.equal(s.settings.enabledSections.contests, false);
    assert.equal(s.settings.enabledSections.attendance, true);
  });
});

describe("isSectionEnabled", () => {
  it("returns true for every section by default", () => {
    for (const key of Object.keys(ALL_ON)) {
      assert.equal(isSectionEnabled(DEFAULT_SETTINGS, key), true);
    }
  });

  it("returns false only for explicitly disabled sections", () => {
    const settings = validateSettings({ enabledSections: { contests: false } });
    assert.equal(isSectionEnabled(settings, "contests"), false);
    assert.equal(isSectionEnabled(settings, "attendance"), true);
  });

  it("treats missing settings as enabled (backward compat)", () => {
    assert.equal(isSectionEnabled(null, "attendance"), true);
    assert.equal(isSectionEnabled({}, "qotd"), true);
  });
});

const NOW = new Date(2026, 9, 11, 12, 0, 0).getTime();
const HOUR = 3600000;

function badgeState(enabledSections) {
  return {
    assignments: [
      { id: "od", dueAt: NOW - HOUR, status: "pending" },
      { id: "td", dueAt: NOW + HOUR, status: "pending" },
    ],
    contests: [
      { id: "lc", startsAt: NOW - HOUR, endsAt: NOW + HOUR },
      { id: "up", startsAt: NOW + 5 * HOUR, endsAt: NOW + 7 * HOUR },
    ],
    timetable: [],
    attendance: { percent: 80, attended: 32, total: 40 },
    qotd: { date: "2026-10-11", solved: true, streak: 1 },
    settings: validateSettings(enabledSections ? { enabledSections } : {}),
  };
}

describe("badgeCount section gating", () => {
  it("counts everything when all sections enabled", () => {
    assert.equal(badgeCount(badgeState(), NOW), 3);
  });

  it("excludes assignments when assignments disabled", () => {
    assert.equal(badgeCount(badgeState({ assignments: false }), NOW), 1);
  });

  it("excludes live contests when contests disabled", () => {
    assert.equal(badgeCount(badgeState({ contests: false }), NOW), 2);
  });
});

describe("digestSummary section gating", () => {
  it("includes everything when all sections enabled", () => {
    const d = digestSummary(badgeState(), NOW);
    assert.equal(d.overdue.length, 1);
    assert.equal(d.dueSoon.length, 1);
    assert.equal(d.upcoming.length, 1);
  });

  it("empties assignment parts when assignments disabled", () => {
    const d = digestSummary(badgeState({ assignments: false }), NOW);
    assert.deepEqual(d.overdue, []);
    assert.deepEqual(d.dueSoon, []);
    assert.equal(d.upcoming.length, 1);
  });

  it("empties upcoming when contests disabled", () => {
    const d = digestSummary(badgeState({ contests: false }), NOW);
    assert.deepEqual(d.upcoming, []);
    assert.equal(d.overdue.length, 1);
  });

  it("empties tomorrow classes when classes disabled", () => {
    const off = badgeState({ classes: false });
    off.timetable = [{ id: "t1", startsAt: NOW + 24 * HOUR }];
    assert.deepEqual(digestSummary(off, NOW).tomorrowsClasses, []);
    const on = badgeState();
    on.timetable = [{ id: "t1", startsAt: NOW + 24 * HOUR }];
    assert.equal(digestSummary(on, NOW).tomorrowsClasses.length, 1);
  });
});
