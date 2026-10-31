# Family Flow

A shared family calendar, task lists and AI assistant. Mobile-first web app (installable on phones), running on Cloudflare.

**Phase 1 status:** built and tested locally (30 automated server tests + a 13-step browser test on an iPhone-sized screen). Not deployed yet; see "Deploy" below.

## What's in Phase 1

| Area | What works | How it was verified |
|---|---|---|
| Accounts | Public sign-up, sign-in, sign-out, password change, delete account. Many families on one server, each fully isolated. Invite links (one-time, 7 days) with roles owner / adult / child. | `test/api.test.js` (isolation, roles, invites, CSRF), e2e invite flow |
| Calendar | Day / week / month / agenda views; recurring events (daily/weekly on chosen days/monthly/yearly, every N, until date or N times); edit or delete "only this", "this and following", or "all"; all-day and multi-day events; per-person colours and filter; private events; reminders; overlap warnings; time-zone correct across DST. | `test/time.test.js`, `test/api.test.js`, e2e |
| Address search | Saved places and recent places first, then Geoapify, falling back to Photon (OpenStreetMap) if Geoapify fails. Starts after 2 letters, keyboard arrows/enter/escape, screen-reader combobox. Says plainly when search is unavailable and keeps the typed name. | `test/ops.test.js` (fallback + degraded flag), e2e |
| Tasks | Lists (to-do / shopping), quick add, due dates and times, assignee, repeat (rolls forward when ticked), reminders. Children can tick but not edit. | tests + e2e |
| Reminders | Scheduled in the database, delivered every minute by a cron job: Inbox entry for everyone + Web Push to phones/computers that turned notifications on. Never double-sends; reminders more than 6 h late go to the Inbox only. | `test/ops.test.js` decrypts the actual push payload and verifies the VAPID signature |
| Assistant | Claude reads your family's members, lists and next 7 days, then *proposes* events/tasks. Nothing is saved until you tap Confirm (or Edit then save). Unknown names or missing times → it asks. | `test/ops.test.js` with a scripted Claude; e2e |
| Voice | Mic button records up to 60 s, Cloudflare Workers AI (Whisper) transcribes, text lands in the assistant box to check before sending. | Unit test with a mocked model. **Not yet tested against the real Whisper model or on a real phone mic.** |
| Offline | App opens offline from a cached copy; changes made offline are queued and sent when back online; if someone else changed the same item, the server copy wins and you're told. The server database is the source of truth. | e2e (goes offline, adds a task, reconnects, checks the server) |
| Import Google / Outlook / Apple | Paste the calendar's private iCal link (step-by-step instructions in the app). Events appear in every view, coloured by the chosen family member, flagged in overlap checks, visible to the assistant, read-only. Refreshed every 15 min by the cron job (and "update now"); changed and deleted events are picked up; a revoked link shows a clear error and Diagnostics turns amber. Handles time zones incl. Outlook's Windows zone names, all-day events, repeats incl. "2nd Tuesday" / "last Friday", skipped and moved occurrences. Private imports visible only to whoever added them. | `test/import.test.js` (Google- and Outlook-shaped feeds), e2e |
| Show Family Flow elsewhere | Private subscription link (ICS) for Apple / Google / Outlook, one-way, shared Family Flow events only (imported ones are left out to avoid duplicates). Link can be rotated. | `test/api.test.js` |
| Backups | Daily gzip of all tables to R2, read back to verify, 35 days kept. D1 also has its own 30-day point-in-time restore. | `test/ops.test.js` restores the backup and checks the data |
| Diagnostics | Owner-only page of live checks: database write/read, schema, cron heartbeat, overdue reminders, push, backups, Geoapify, Photon, Claude API key + model, Workers AI. A check is only green if it actually ran and passed. | `test/ops.test.js` |

## Not done yet (honest list)

- **"Sign in with Google / Microsoft" calendar connection and two-way editing.** Import today uses private iCal links (no app approval needed). Signing in instead of pasting a link, faster updates, and editing Google/Outlook events from Family Flow need a Google Cloud app (Google verification for calendar access) and a Microsoft Entra app registration. Phase 2.
- Some work/school accounts block the private iCal link (Google Workspace) or calendar publishing (Microsoft 365); then import isn't possible until the IT admin allows it or Phase 2 sign-in exists.
- Imported events cover 60 days back to 400 days ahead.
- **Email** (password reset, invite emails). There is no email provider yet, so a forgotten password currently needs an admin. Invite links are shared by copy/share instead.
- Voice and push need checking on real devices after deploy (iPhone push only works after "Add to Home Screen").
- Editing a *recurring* event while offline is blocked (simple edits and new items work offline).
- No prompt caching yet for the assistant (would cut its cost by roughly half).
- One D1 database holds everyone; D1's 10 GB limit means sharding is needed somewhere past ~50k busy households.

## Deploy (Cloudflare Workers + GitHub)

1. Create a **private** GitHub repo and push this code to it.
2. Cloudflare dashboard → Storage & Databases → **D1** → Create database `family-flow`. Copy its ID into `wrangler.toml` (`database_id`).
3. **R2** → Create bucket `family-flow-backups`.
4. Workers & Pages → Create → **Import a repository** → pick the repo.
   - Build command: *(empty)*
   - Deploy command: `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`
5. Worker → Settings → Variables and Secrets → add **Secrets** (type them yourself):
   - `ANTHROPIC_API_KEY` (console.anthropic.com → API keys)
   - `GEOAPIFY_API_KEY` (myprojects.geoapify.com → new project → API key). Optional but recommended.
6. Open the `*.workers.dev` URL, create your family, then More → Diagnostics. Everything should be OK except "cron" and "backups", which turn green within a minute and after the first night.

`ADMIN_EMAILS` in `wrangler.toml` controls who can run manual backups and see diagnostics for every household.

## Develop

Requires Node 22+. No npm packages needed.

```sh
npm test                                   # 30 server tests (node:test, SQLite stand-in for D1)
MOCK_AI=1 MOCK_PLACES=1 node scripts/dev-server.js 8787 /tmp/dev.sqlite
node e2e/smoke.mjs http://localhost:8787   # browser test (needs Playwright installed)
```

If you change `src/lib/time.js`, copy it to `public/js/time.js` (a test checks they match).

## Layout

```
src/index.js            routes, security headers, cron entry
src/lib/                auth, database helpers, time zones + recurrence, reminders, Web Push
src/routes/             account, calendar+tasks, places, assistant+voice, ops (inbox, push, cron, backups, diagnostics)
migrations/             D1 schema
public/                 the app (plain JS modules, no build step), service worker, icons
test/, e2e/             automated tests
scripts/dev-server.js   runs the real Worker locally
```

## Running cost (estimate, per month)

Assumptions per household per month: ~5,000 API requests (app open ~15 min/day, syncing every 30 s), 30 assistant messages, 20 voice notes of 15 s, ~100 address lookups. Prices as of Oct 2026: Workers Paid $5 incl. 10M requests then $0.30/M; Claude Sonnet 5.5 ≈ $2 / $10 per M input/output tokens (third-party listing, check Anthropic's page); Whisper turbo $0.0005/audio-min with 10k free Neurons/day; Geoapify free 3k/day, then $59 (10k/day), $179 (50k/day), custom from $860.

| Households | Cloudflare (Workers, D1, R2, cron) | Address search | Voice | Assistant (Claude) | **Total** |
|---:|---:|---:|---:|---:|---:|
| 100 | $5 | $0 (free tier) | $0 | ~$80 | **~$85** |
| 1,000 | ~$5–10 | $59 | ~$1 | ~$800 | **~$870** |
| 10,000 | ~$25–40 | $179 | ~$25 | ~$8,000 | **~$8,200** |
| 100,000 | ~$250–400 (+ D1 sharding work) | ~$860+ | ~$250 | ~$80,000 | **~$81,000** |

The assistant is ~95% of the cost (~$0.80 per active household/month at 30 messages; about one third of that for light users). Prompt caching and routing simple requests to Haiku would roughly halve it. Daily per-household caps (150 assistant messages, 100 transcriptions, 1,500 address lookups) stop runaway bills; change with `CAP_ASSISTANT` etc.
