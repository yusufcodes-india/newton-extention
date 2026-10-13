import { todayStr } from "./rules.js";

export function hashStr(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

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
    u.includes("/details") ||
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
  let pair = null;
  const pairRe = /(\d+)\s*\/\s*(\d+)/g;
  let pm;
  while ((pm = pairRe.exec(text)) !== null) {
    const ctx = text.slice(
      Math.max(0, pm.index - 40),
      Math.min(text.length, pm.index + pm[0].length + 40)
    );
    if (/class|lecture|session|attendance|present/i.test(ctx)) {
      pair = pm;
      break;
    }
  }
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
  while ((m = re.exec(text)) !== null && items.length < 50) {
    const dueAt = Date.parse(m[2]);
    if (Number.isNaN(dueAt)) continue;
    const title = m[1].trim().slice(-80);
    items.push({
      id: `auto-assign-${hashStr(`${title}|${dueAt}`)}`,
      title,
      course: "",
      dueAt,
      status: /submitted|done|completed/i.test(m[1]) ? "submitted" : "pending",
      url: "",
      source: "auto",
      confidence: "low",
    });
  }
  return { items, confidence: items.length ? "low" : "none", selectorUsed: "text-scan:v1" };
}

export function parseContests(html) {
  const text = stripTags(html);
  const re = new RegExp(`(.{8,60}?)\\s*(?:starts|begins|live)\\s*(?:on\\s*|at\\s*)?${DATE_RE}`, "gi");
  const items = [];
  let m;
  while ((m = re.exec(text)) !== null && items.length < 50) {
    const startsAt = Date.parse(m[2]);
    if (Number.isNaN(startsAt)) continue;
    const title = m[1].trim().slice(-60);
    items.push({
      id: `auto-contest-${hashStr(`${title}|${startsAt}`)}`,
      title,
      startsAt,
      endsAt: startsAt + 3 * 3600000,
      url: "",
      source: "auto",
      confidence: "low",
    });
  }
  return { items, confidence: items.length ? "low" : "none", selectorUsed: "text-scan:v1" };
}

export function parseTimetable(html) {
  const text = stripTags(html);
  const re = /(.{4,60}?)\s*(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)/g;
  const items = [];
  let m;
  const today = todayStr(Date.now());
  while ((m = re.exec(text)) !== null && items.length < 50) {
    const title = m[1].trim().slice(-60);
    const startsAt = Date.parse(`${today} ${m[2]}`);
    if (Number.isNaN(startsAt)) continue;
    items.push({
      id: `auto-class-${hashStr(`${title}|${startsAt}`)}`,
      title,
      startsAt,
      joinUrl: "",
      source: "auto",
      confidence: "low",
    });
  }
  const clean = items.filter((c) => !Number.isNaN(c.startsAt));
  return { items: clean, confidence: clean.length ? "low" : "none", selectorUsed: "text-scan:v1" };
}

export function parseQotd(html) {
  const text = stripTags(html);
  const streak = text.match(/streak[^0-9]{0,12}(\d+)/i);
  return {
    date: todayStr(Date.now()),
    solved: /question of the day[\s\S]{0,300}(solved|accepted|completed)/i.test(text),
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
