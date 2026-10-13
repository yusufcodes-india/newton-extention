import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NewtonError,
  fetchAssignments,
  fetchContests,
  fetchLectures,
  fetchQuizzes,
  fetchPerformance,
  fetchUnits,
  parseAssignments,
  parseContests,
  parseLectures,
  parsePerformance,
  parseUnits,
  pickCourse,
} from "../src/utils/newton.js";

const stubFetch = (handler) => (url, opts) => handler(url, opts);
const okJson = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("parseUnits", () => {
  const payload = [
    {
      short_display_name: "Parent",
      children_courses: {
        admin_unit_courses: [
          {
            hash: "u1",
            short_display_name: "Course One",
            learning_unit_courses: [
              { hash: "s1", short_display_name: "DSA" },
              { hash: "s2", title: "DBMS" },
              { hash: "", title: "Ghost" },
            ],
          },
        ],
      },
    },
  ];

  it("parses array form, filters hashless subjects", () => {
    const out = parseUnits(payload);
    assert.equal(out.length, 1);
    assert.equal(out[0].hash, "u1");
    assert.equal(out[0].name, "Course One");
    assert.deepEqual(
      out[0].subjects.map((s) => s.hash),
      ["s1", "s2"]
    );
    assert.equal(out[0].subjects[0].title, "DSA");
  });

  it("parses {results} form", () => {
    assert.equal(parseUnits({ results: payload }).length, 1);
  });

  it("throws shape on unknown payload", () => {
    assert.throws(() => parseUnits({ nope: 1 }), (e) => e instanceof NewtonError && e.code === "shape");
  });
});

describe("parsePerformance", () => {
  it("accepts valid numbers", () => {
    assert.deepEqual(parsePerformance({ total_lectures: 40, total_lectures_attended: 33 }), {
      total: 40,
      attended: 33,
    });
  });

  it("rejects attended > total and non-integers", () => {
    assert.throws(() => parsePerformance({ total_lectures: 40, total_lectures_attended: 41 }), /shape/);
    assert.throws(() => parsePerformance({ total_lectures: 40.5, total_lectures_attended: 3 }), /shape/);
    assert.throws(() => parsePerformance({}), /shape/);
  });
});

describe("pickCourse", () => {
  const units = [
    { hash: "u1", subjects: [] },
    { hash: "u2", subjects: [] },
  ];

  it("matches first known hash", () => {
    assert.equal(pickCourse(units, ["nope", "u2"]).hash, "u2");
  });

  it("auto-picks a single unit", () => {
    assert.equal(pickCourse([units[0]], []).hash, "u1");
  });

  it("returns null on ambiguity or emptiness", () => {
    assert.equal(pickCourse(units, []), null);
    assert.equal(pickCourse([], ["u1"]), null);
  });
});

describe("fetch wrappers", () => {
  it("sends Bearer auth to the units endpoint", async () => {
    let seen = null;
    const f = stubFetch((url, opts) => {
      seen = { url, auth: opts.headers.Authorization };
      return okJson([]);
    });
    await fetchUnits(f, "tok123");
    assert.ok(seen.url.includes("/api/v2/course/all/applied/"));
    assert.equal(seen.auth, "Bearer tok123");
  });

  it("throws no-token without a token", async () => {
    await assert.rejects(fetchUnits(stubFetch(() => okJson([])), ""), (e) => e.code === "no-token");
  });

  it("maps 401 to auth, 500 to http, bad json to shape", async () => {
    const f401 = stubFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
    await assert.rejects(fetchPerformance(f401, "t", "h"), (e) => e.code === "auth");
    const f500 = stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    await assert.rejects(fetchPerformance(f500, "t", "h"), (e) => e.code === "http");
    const fBad = stubFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error("x"); } }));
    await assert.rejects(fetchPerformance(fBad, "t", "h"), (e) => e.code === "shape");
  });

  it("maps abort to timeout", async () => {
    const f = stubFetch((url, opts) =>
      new Promise((_, rej) => {
        opts.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          rej(e);
        });
      })
    );
    await assert.rejects(fetchUnits(f, "t", 5), (e) => e.code === "timeout");
  });

  it("hits the per-subject performance endpoint", async () => {
    let seen = null;
    const f = stubFetch((url) => {
      seen = url;
      return okJson({ total_lectures: 10, total_lectures_attended: 9 });
    });
    const out = await fetchPerformance(f, "t", "abc/def");
    assert.ok(seen.includes("/api/v2/course/h/abc%2Fdef/self_performance/"));
    assert.deepEqual(out, { total: 10, attended: 9 });
  });
});

describe("parseAssignments", () => {
  it("maps aliased keys and flags submitted states", () => {
    const out = parseAssignments({
      results: [
        { title: "Binary Search", due_at: "2026-10-20T10:00:00Z", attempt_status: "pending" },
        { name: "DBMS Quiz", deadline: "2026-10-21", status: "Submitted" },
        { title: "No due date", status: "pending" },
        { title: "", due_at: "2026-10-21" },
        "junk",
      ],
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].title, "Binary Search");
    assert.equal(out[0].status, "pending");
    assert.equal(out[0].source, "auto-api");
    assert.equal(out[0].confidence, "medium");
    assert.ok(out[0].id.startsWith("api-assign-"));
    assert.equal(out[1].status, "submitted");
  });

  it("accepts bare arrays and epoch seconds", () => {
    const out = parseAssignments([{ topic: "Arrays", ends_at: 1761000000 }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].dueAt, 1761000000 * 1000);
  });

  it("throws shape when no list present", () => {
    assert.throws(() => parseAssignments({ nope: [] }), (e) => e.code === "shape");
  });
});

describe("fetchAssignments", () => {
  it("calls the course assignment endpoint with limit", async () => {
    let seen = null;
    const f = stubFetch((url, opts) => {
      seen = { url, auth: opts.headers.Authorization };
      return okJson({ results: [] });
    });
    const out = await fetchAssignments(f, "tok", "hash1");
    assert.ok(seen.url.includes("/api/v2/course/h/hash1/assignment/all/"));
    assert.ok(seen.url.includes("limit=50"));
    assert.ok(seen.url.includes("offset=0"));
    assert.equal(seen.auth, "Bearer tok");
    assert.deepEqual(out, []);
  });

  it("auto-pages until a short page and dedupes by id", async () => {
    const calls = [];
    const item = (n) => ({ title: `A${n}`, due_at: "2026-10-20", status: "pending" });
    const f = stubFetch((url) => {
      calls.push(url);
      if (url.includes("offset=0")) return okJson({ results: [item(1), item(2)] });
      return okJson({ results: [] });
    });
    const out = await fetchAssignments(f, "t", "h", 2);
    assert.equal(out.length, 2);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].includes("offset=2"));
  });

  it("requires token and course hash", async () => {
    const f = stubFetch(() => okJson([]));
    await assert.rejects(fetchAssignments(f, "", "h"), (e) => e.code === "no-token");
    await assert.rejects(fetchAssignments(f, "t", ""), (e) => e.code === "no-course");
  });
});

describe("parseContests", () => {
  it("maps assessment start/end shapes", () => {
    const out = parseContests({
      results: [{ title: "CodeRush Weekly", start_at: "2026-10-20T10:00:00Z", end_at: "2026-10-20T13:00:00Z" }],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "CodeRush Weekly");
    assert.equal(out[0].startsAt, Date.parse("2026-10-20T10:00:00Z"));
    assert.equal(out[0].endsAt, Date.parse("2026-10-20T13:00:00Z"));
    assert.ok(out[0].id.startsWith("api-contest-"));
    assert.equal(out[0].source, "auto-api");
  });

  it("falls back to due-only with +3h end", () => {
    const out = parseContests([{ name: "Quiz Bowl", due_at: "2026-10-21T10:00:00Z" }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].endsAt - out[0].startsAt, 3 * 3600000);
  });

  it("skips dateless entries, throws on shapeless payload", () => {
    assert.deepEqual(parseContests([{ title: "No date" }]), []);
    assert.throws(() => parseContests({ nope: 1 }), (e) => e.code === "shape");
  });
});

describe("fetchContests", () => {
  it("hits both contest endpoints and merges", async () => {
    const seen = [];
    const f = stubFetch((url) => {
      seen.push(url);
      if (url.includes("/assessment/all/")) {
        return okJson({ results: [{ title: "A", start_at: "2026-10-20T10:00:00Z", end_at: "2026-10-20T12:00:00Z" }] });
      }
      return okJson({ results: [] });
    });
    const out = await fetchContests(f, "tok", "h1");
    assert.ok(seen.some((u) => u.includes("/assignment/all/") && u.includes("is_contest=true")));
    assert.ok(seen.some((u) => u.includes("/assessment/all/") && u.includes("is_contest=true")));
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "A");
  });

  it("requires token and course hash", async () => {
    const f = stubFetch(() => okJson([]));
    await assert.rejects(fetchContests(f, "", "h"), (e) => e.code === "no-token");
    await assert.rejects(fetchContests(f, "t", ""), (e) => e.code === "no-course");
  });
});

describe("fetchQuizzes", () => {
  it("hits the plain assessment endpoint with quiz ids", async () => {
    let seen = null;
    const f = stubFetch((url) => {
      seen = url;
      return okJson({ results: [{ title: "Q1", due_at: "2026-10-22T10:00:00Z", status: "pending" }] });
    });
    const out = await fetchQuizzes(f, "tok", "h1");
    assert.ok(seen.includes("/assessment/all/"));
    assert.ok(!seen.includes("is_contest"));
    assert.equal(out.length, 1);
    assert.ok(out[0].id.startsWith("api-quiz-"));
  });

  it("requires token and course hash", async () => {
    const f = stubFetch(() => okJson([]));
    await assert.rejects(fetchQuizzes(f, "", "h"), (e) => e.code === "no-token");
    await assert.rejects(fetchQuizzes(f, "t", ""), (e) => e.code === "no-course");
  });
});

describe("parseLectures + fetchLectures", () => {
  it("maps scheduler shapes with join links", () => {
    const out = parseLectures({
      results: [{ title: "DSA Live", start_at: "2026-10-20T10:00:00Z", end_at: "2026-10-20T11:00:00Z", join_url: "https://meet.example/x" }],
    });
    assert.equal(out.length, 1);
    assert.ok(out[0].id.startsWith("api-class-"));
    assert.equal(out[0].joinUrl, "https://meet.example/x");
    assert.equal(out[0].source, "auto-api");
  });

  it("defaults end to start+1h and skips dateless", () => {
    const out = parseLectures([{ title: "DBMS", scheduled_at: "2026-10-21T10:00:00Z" }, { title: "No time" }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].endsAt - out[0].startsAt, 3600000);
  });

  it("throws shape on unrecognizable payload, guards auth", async () => {
    assert.throws(() => parseLectures({ nope: 1 }), (e) => e.code === "shape");
    const f = stubFetch(() => okJson([]));
    await assert.rejects(fetchLectures(f, "", "h"), (e) => e.code === "no-token");
    await assert.rejects(fetchLectures(f, "t", ""), (e) => e.code === "no-course");
  });

  it("hits the learning_course endpoint", async () => {
    let seen = null;
    const f = stubFetch((url) => {
      seen = url;
      return okJson({ results: [] });
    });
    await fetchLectures(f, "tok", "h1");
    assert.ok(seen.includes("/learning_course/all/"));
    assert.ok(seen.includes("pagination=false"));
  });
});
