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

1. Log in at `my.newtonschool.co` and browse any page. The extension
   picks up your session token + course automatically.
2. Open the popup: Today / Assignments / Attendance (overall +
   per-subject) / Contests / QOTD. Hit ↻ for a forced refresh.
3. Right-click the toolbar icon → Options to set digest time (default
   21:00), attendance threshold (default 75%), lead times, quiet hours.
4. Fully automatic — no hand entry. Attendance, assignments (+quizzes),
   contests, timetable, and QOTD all sync from Newton's API.
   QOTD uses `GET /api/v1/assignment/question_of_the_day_detail/`
   (works even logged-out for title/date; Bearer unlocks solved state).
5. If the popup shows the logged-out banner, sign in to Newton again.
   QOTD title still refreshes anonymously; attendance/assignments need login.

## How sync works

- Attendance is API-driven: the content script reads your session token
  (`localStorage` `auth-token` or the `access_token_ns_student_web`
  cookie — your own login, never stored passwords/OTP) and the
  background worker calls Newton's course/performance/assignment/
  assessment/lecture endpoints with it (`Authorization: Bearer`).
  QOTD calls `GET /api/v1/assignment/question_of_the_day_detail/`
  with Bearer when logged in, anonymous otherwise.
  Refresh every 30 min, on browser startup,
  on install, and on ↻. `401/403` means the session expired → logged-out
  banner + one nudge per day.
- No third-party servers: the token never leaves your machine except to
  `my.newtonschool.co` API calls.
- `src/utils/parsers.js` (DOM text-scans) is currently unwired and kept
  as a dormant fallback; Manual Add is the reliable path for
  assignments/contests/timetable.

## Tests

`npm test` — pure-logic suites for storage, rules, parsers, and the
Newton API client (network stubbed; no live calls in tests).
