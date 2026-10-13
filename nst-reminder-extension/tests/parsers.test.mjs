import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectPageType,
  hashStr,
  parseAssignments,
  parseAttendance,
  parseContests,
  parsePage,
  parseQotd,
  parseTimetable,
} from "../src/utils/parsers.js";
import { todayStr } from "../src/utils/rules.js";

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
    assert.equal(
      detectPageType("https://my.newtonschool.co/course/97b4lmwd3sb2/details/extra", "Course"),
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

  it("ignores x/y pairs without a nearby attendance keyword", () => {
    const r = parseAttendance("<div><p>Solved 3/5 problems today</p></div>");
    assert.equal(r.percent, null);
    assert.equal(r.attended, 0);
    assert.equal(r.total, 0);
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

  it("does not mark solved from unrelated completion text", () => {
    const q = parseQotd("<div><p>Completed courses: 4</p><p>Keep learning!</p></div>");
    assert.equal(q.solved, false);
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

describe("auto tagging and content-hash ids", () => {
  it("tags every auto item with source auto and parse confidence", () => {
    const a = parseAssignments("<ul><li>Binary Search Homework due Oct 12, 2026</li></ul>");
    assert.ok(a.items.length > 0);
    for (const item of a.items) {
      assert.equal(item.source, "auto");
      assert.equal(item.confidence, "low");
    }
    const c = parseContests("<div>CodeRush Weekly starts Oct 20, 2026</div>");
    assert.ok(c.items.length > 0);
    for (const item of c.items) {
      assert.equal(item.source, "auto");
      assert.equal(item.confidence, "low");
    }
    const t = parseTimetable("<div>DSA Lecture 10:30 AM</div>");
    assert.ok(t.items.length > 0);
    for (const item of t.items) {
      assert.equal(item.source, "auto");
      assert.equal(item.confidence, "low");
    }
  });

  it("derives stable content-hash ids that change with content", () => {
    const first = parseAssignments("<ul><li>Binary Search Homework due Oct 12, 2026</li></ul>");
    const second = parseAssignments("<ul><li>Binary Search Homework due Oct 12, 2026</li></ul>");
    assert.ok(first.items[0].id.startsWith("auto-assign-"));
    assert.equal(first.items[0].id, second.items[0].id);
    const other = parseAssignments("<ul><li>DBMS Quiz Homework due Oct 12, 2026</li></ul>");
    assert.notEqual(first.items[0].id, other.items[0].id);
    assert.equal(hashStr("abc"), hashStr("abc"));
    assert.notEqual(hashStr("abc"), hashStr("abd"));
  });

  it("dates every timetable entry to the same local day", () => {
    const r = parseTimetable("<div>DSA Lecture 10:30 AM</div><div>DBMS Lab 02:00 PM</div>");
    assert.equal(r.items.length, 2);
    const expectedDay = todayStr(Date.now());
    for (const item of r.items) {
      const d = new Date(item.startsAt);
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      assert.equal(`${d.getFullYear()}-${mm}-${dd}`, expectedDay);
    }
  });
});
