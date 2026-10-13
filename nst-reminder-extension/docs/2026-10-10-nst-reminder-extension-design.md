# NST Reminder Extension — Design Spec (2026-10-10)

## Context
- User: Newton School of Technology student, browser = Opera GX (Chromium, MV3-compatible).
- Target portal: `https://my.newtonschool.co/course/97b4lmwd3sb2/details` + surrounding portal pages (attendance, assignments, timetable, contests, QOTD).
- Scan result: page is behind login. Firecrawl scrape (`--only-main-content` and `--wait-for 5000`) + WebFetch both returned only the public login/signup shell. No authenticated data accessible without user session.
- Public portal surface (from newtonschool.co + search): Question of the Day + leaderboard (`/question-of-the-day`), CodeRush contests (`/contest/all`), Playgrounds/online compiler (`/playgrounds`), Games, Job Board (`/job-board/job-board`), Tryouts (`/tryouts`), Masterclasses/events (`/events/...`).
- Repo: this standalone repo (`nst-reminder-extension`). Extension is vanilla MV3, no backend.

## Goals
1. Remind: attendance (low-% alerts + bunk predictor), assignments (24h / 1h / overdue), contests (upcoming + live), timetable classes (10-min-before + join link).
2. Reminder surfaces (all requested): desktop notifications, popup dashboard, badge counter, daily digest at user-chosen time.
3. Extras (all requested): QOTD streak nudge, contest tracker with countdown + join, timetable + class-join shortcut, playground shortcut, attendance predictor.
4. Private + local-first: no backend, no credential exfiltration, works with the user's existing logged-in Newton session.

## Non-goals
- No auto-login, no OTP handling, no password storage.
- No server, no account system, no cross-device cloud sync in v1 (optional later via chrome.storage.sync for settings only).
- No scraping of non-Newton sites. No `<all_urls>`.

## Approach (approved: A — Pure MV3 local scraper)
- Content script runs only on `my.newtonschool.co` while user is logged in, parses DOM, writes normalized records to `chrome.storage.local`.
- Background service worker owns scheduling (`chrome.alarms`), badge, notifications, digest.
- Popup dashboard reads storage and renders Today / Assignments / Attendance / Contests.
- Options page: digest time, attendance threshold (default 75%), lead times, quiet hours.
- Manual Add fallback in popup when auto-parse finds nothing or portal redesigns.
- Rejected B (MV3 + Next.js companion): heavier hosting/auth for little gain. Rejected C (manual-only): loses auto-read magic.

## Architecture
```
nst-reminder-extension/
  manifest.json (MV3, Opera GX + Chrome)
  src/content.js        — match my.newtonschool.co/*, page-type routers + parsers
  src/background.js     — alarms, rules engine, notifications, badge, digest
  src/popup.html/js/css — dashboard (Today, Assignments, Attendance, Contests, QOTD)
  src/options.html/js   — digest time, thresholds, lead times, quiet hours
  src/utils/storage.js  — storage schema + read/write helpers
  src/utils/parsers.js  — per-field parsers with 2-3 fallback selectors each
  icons/                — 16/32/48/128
```

## Components
1. **Attendance card**: % present, classes attended/total, predictor ("you can bunk N more before dropping below X%"), red alert when below threshold or projected below.
2. **Assignments list**: title, course, due datetime, days-left, status (pending/submitted/overdue), link. Sorted by urgency. Rules: notify at 24h, 1h, overdue.
3. **Contests**: CodeRush + course contests, start time, countdown, Join button, live-now notification + badge bump.
4. **Timetable**: today's classes, time, join link, 10-min-before notification, "Join now" in popup.
5. **QOTD**: solved/unsolved, streak count, nudge if unsolved by 18:00 local.
6. **Playground shortcut**: one-click open + recent snippet links (local only).
7. **Badge counter**: count = overdue assignments + due-today + live contests. Clears when resolved.
8. **Daily digest**: fires at user time (default 21:00), summarizes tomorrow's classes, due-soon, contests, attendance risk.

## Data flow
1. User browses Newton logged-in → content.js detects page type (details / attendance / assignments / schedule / contest / QOTD) → extracts → validates → writes `{ records, lastSyncAt, sourceUrl }` to storage.
2. Background alarms: `sync-check` every 15 min (evaluate rules on cached data), `digest` daily at user time, `midnight-rollover` to reset Today.
3. Rules engine pure functions: `dueSoon(assignments, now)`, `attendanceRisk(attendance, threshold)`, `liveContests(contests, now)`, `classStartingSoon(timetable, now)`, `qotdUnsolved(qotd, now)` → notifications + badge.
4. Staleness: if `now - lastSyncAt > 24h`, popup banner "Data stale — open Newton portal to refresh" + Manual Add CTA.
5. No network calls except opening Newton links the user clicks.

## Storage schema (chrome.storage.local)
```json
{
  "attendance": { "percent": 82.5, "attended": 33, "total": 40, "threshold": 75, "updatedAt": 0 },
  "assignments": [{ "id": "a1", "title": "", "course": "", "dueAt": 0, "status": "pending", "url": "", "updatedAt": 0 }],
  "contests": [{ "id": "c1", "title": "", "startsAt": 0, "endsAt": 0, "url": "", "status": "upcoming" }],
  "timetable": [{ "id": "t1", "title": "", "startsAt": 0, "joinUrl": "" }],
  "qotd": { "date": "2026-10-10", "solved": false, "streak": 0 },
  "settings": { "digestTime": "21:00", "attendanceThreshold": 75, "assignmentLeadsMin": [1440, 60], "classLeadMin": 10, "qotdNudgeHour": 18, "quietHours": null },
  "meta": { "lastSyncAt": 0, "notifiedIds": [] }
}
```

## Permissions (minimal)
- `permissions: ["storage", "alarms", "notifications"]`
- `host_permissions: ["https://my.newtonschool.co/*"]`
- No `cookies`, no `webRequest`, no `<all_urls>`, no remotely-hosted code (MV3 CSP compliant, Opera GX sideload OK).

## Parser hardening (login-wall consequence)
- Each field gets 2–3 selectors: semantic (`[data-testid]`, aria) → text-anchored (XPath/text scan) → structural fallback (table/list position).
- Every parser returns `{ value, confidence, selectorUsed }`; low-confidence values flagged "verify" in popup, never trigger false critical alerts.
- Needs from user to finalize: saved HTML (View Source, no passwords) of logged-in Attendance tab, Assignments list, Contests page, Timetable/Schedule. Without these, v1 ships with best-guess selectors + Manual Add.

## Error handling
- Parse miss → keep last good value, mark stale, no notification spam.
- Clock skew → all times stored as epoch ms + original string; display in local tz.
- Notification dedupe via `meta.notifiedIds` (key = rule + entity id + day).
- Quiet hours respected (default none; user can set e.g. 23:00–07:00 → digest only).

## Testing
1. `opera://extensions` → Developer mode → Load unpacked → this folder.
2. Log in to Newton, visit each tab, open popup → verify cards populate + `lastSyncAt` fresh.
3. Force rules: set assignment due in 5 min, class in 5 min, threshold above current % → expect notifications + badge.
4. Set digest time to +2 min → expect digest notification.
5. Reload portal after Newton UI change → confirm fallback selectors or Manual Add path.

## Open inputs needed (from user)
1. Saved HTML snippets of the 4 logged-in pages (attendance, assignments, contests, timetable).
2. Confirm digest default 21:00 + attendance threshold 75% (or your numbers).
3. Opera GX notification permission + pin extension to toolbar (steps in README).

## Milestones (spec-only; plan comes from writing-plans skill)
- M1 scaffold + storage + popup shell + manual add.
- M2 content parsers per page + sync status.
- M3 rules engine + notifications + badge + digest.
- M4 QOTD/contest/timetable extras + polish + Opera GX install README.
