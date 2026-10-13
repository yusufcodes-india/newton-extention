import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NewtonError, fetchQotd, parseQotdDetail } from "../src/utils/newton.js";
import { applyApiQotd, createInitialState, normalizeState } from "../src/utils/storage.js";

const stubFetch = (handler) => (url, opts) => handler(url, opts);
const okJson = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// Live unauthenticated shape observed 2026-10-11 via WebFetch.
const UNSOLVED = {
  assignmentQuestionTitle: "Courier Speed Limit",
  milestoneUserQuestionMapping: null,
  rank: null,
  attemptedByCount: 4,
  date: 1791657000000,
  randomThreeAttemptedUserAvatars: [],
  timeLeftForEod: 65280691,
  slug: "courier-speed-limit",
  defaultCompilerSlug: "java-compiler",
};

describe("parseQotdDetail", () => {
  it("maps unsolved v1 payload (null mapping => unsolved)", () => {
    const out = parseQotdDetail(UNSOLVED);
    assert.equal(out.title, "Courier Speed Limit");
    assert.equal(out.slug, "courier-speed-limit");
    assert.equal(out.solved, false);
    assert.equal(out.date, "2026-10-11");
    assert.equal(out.url, "https://my.newtonschool.co/question-of-the-day/courier-speed-limit");
    assert.equal(out.source, "api");
    assert.equal(out.confidence, "high");
    assert.equal(typeof out.timeLeftMs, "number");
  });

  it("maps solved payload (object mapping => solved)", () => {
    const out = parseQotdDetail({
      ...UNSOLVED,
      milestoneUserQuestionMapping: { status: "accepted", score: 100 },
      rank: 3,
    });
    assert.equal(out.solved, true);
    assert.equal(out.title, "Courier Speed Limit");
    assert.equal(out.slug, "courier-speed-limit");
  });

  it("accepts solved/status string variants", () => {
    const solved = parseQotdDetail({ ...UNSOLVED, status: "Solved" });
    assert.equal(solved.solved, true);
    const accepted = parseQotdDetail({ ...UNSOLVED, attempt_status: "accepted" });
    assert.equal(accepted.solved, true);
  });

  it("throws shape on unrecognizable payload", () => {
    assert.throws(() => parseQotdDetail({ nope: 1 }), (e) => e instanceof NewtonError && e.code === "shape");
    assert.throws(() => parseQotdDetail(null), (e) => e instanceof NewtonError && e.code === "shape");
  });
});

describe("fetchQotd", () => {
  it("hits the v1 QOTD endpoint with Bearer when token present", async () => {
    let seen = null;
    const f = stubFetch((url, opts) => {
      seen = { url, auth: opts.headers.Authorization };
      return okJson(UNSOLVED);
    });
    const out = await fetchQotd(f, "tok123");
    assert.ok(seen.url.endsWith("/api/v1/assignment/question_of_the_day_detail/"));
    assert.equal(seen.auth, "Bearer tok123");
    assert.equal(out.title, "Courier Speed Limit");
  });

  it("works without a token (endpoint allows anonymous)", async () => {
    let seen = null;
    const f = stubFetch((url, opts) => {
      seen = { url, headers: opts.headers };
      return okJson(UNSOLVED);
    });
    const out = await fetchQotd(f, null);
    assert.ok(seen.url.includes("/question_of_the_day_detail/"));
    assert.equal(out.solved, false);
  });

  it("maps 401 to auth", async () => {
    const f = stubFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
    await assert.rejects(fetchQotd(f, "t"), (e) => e.code === "auth");
  });
});

describe("applyApiQotd", () => {
  it("writes QOTD api data and stamps sync, preserves streak when absent", () => {
    const s = createInitialState();
    s.qotd.streak = 5;
    const next = applyApiQotd(
      s,
      { title: "Courier Speed Limit", slug: "courier-speed-limit", url: "https://x", date: "2026-10-11", solved: false, source: "api", confidence: "high" },
      9000
    );
    assert.equal(next.qotd.title, "Courier Speed Limit");
    assert.equal(next.qotd.solved, false);
    assert.equal(next.qotd.streak, 5);
    assert.equal(next.qotd.source, "api");
    assert.equal(next.meta.lastSyncAt, 9000);
  });

  it("keeps streak when solved payload carries explicit streak", () => {
    const s = createInitialState();
    const next = applyApiQotd(
      s,
      { title: "T", slug: "s", url: "", date: "2026-10-11", solved: true, streak: 7, source: "api", confidence: "high" },
      9000
    );
    assert.equal(next.qotd.solved, true);
    assert.equal(next.qotd.streak, 7);
  });

  it("normalizeState keeps new qotd fields", () => {
    const s = normalizeState({ qotd: { title: "T", slug: "s", url: "https://x", source: "api", confidence: "high" } });
    assert.equal(s.qotd.title, "T");
    assert.equal(s.qotd.source, "api");
  });
});
