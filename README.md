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
| Sign in with Google / Microsoft | One tap, read-only (OAuth 2.0 + PKCE). Pick which calendars to show; refreshed every 15 min; refresh tokens stored encrypted with a key derived from the provider's client secret; revoked access shows Reconnect. Needs the app registered once with Google Cloud and Microsoft Entra (secrets above). | `test/oauth.test.js` (simulated Google + Microsoft), e2e (redirect) |
| Show Family Flow elsewhere | Private subscription link (ICS) for Apple / Google / Outlook, one-way, shared Family Flow events only (imported ones are left out to avoid duplicates). Link can be rotated. | `test/api.test.js` |
| Backups | Daily gzip of all tables to R2, read back to verify, 35 days kept. D1 also has its own 30-day point-in-time restore. | `test/ops.test.js` restores the backup and checks the data |
| Family groups | Groups inside a household (e.g. Nuclear / Extended family). Events can be shared with everyone, one group, or only me; lists can be limited to a group you're in. Non-members never receive those items in sync, exports, the assistant, reminders or the shared calendar feed. Deleting a group shares its items with everyone. | `test/groups.test.js` |
| Family updates | Inbox + push alert to everyone else who can see it when an event is added, moved/renamed/relocated, or cancelled, and to the assignee when a task is assigned. Notes-only edits and private events stay silent. Each person can turn these off (More → Notifications). | `test/groups.test.js` |
| Icons & avatars | Events show an icon suggested from the title (⚽ soccer, 🦷 dentist, 🎂 birthday…), which you can change or turn off. Profiles can have a photo (cropped and shrunk on the phone, stored ≤ ~100 KB) or an emoji avatar. Shopping-list items have a "Buy on Amazon" link (opens an Amazon search). | `test/groups.test.js`, browser check |
| Holidays | US federal holidays (plus the weekday off when one falls on a weekend) and popular observances (Mother’s Day, Halloween…) appear on the calendar automatically for US time zones. Calculated on the device, read-only. More → Household: Automatic / United States / Off. | `test/holidays.test.js` |
| Voice for tasks | Mic button on the task form, the event title and every list's add box. On shopping lists, saying “milk, eggs and bread” adds three items at once; on to-do lists the words go into the box to check first. | browser check with `MOCK_VOICE` |
| Import from a PDF or photo | + → “From a PDF or photo”. The assistant (Claude) reads a school calendar, sports schedule or a photo of a flyer, lists every date it finds, flags ones already on the calendar, and you tick which to add (with who, sharing and a reminder applied to all). One “added N events” alert goes to the family. 10 MB max, 20 imports per family per day. | API tests with a mocked model; browser check with `MOCK_AI`. **Not yet tried on a real PDF against the live model.** |
| List of entries | Calendar → **List**: every event in one scrollable list (no tapping into days). Filter by when it happens (upcoming, next 7 days, this/next month, past, any, or pick dates) and by when it was added (today, yesterday, last 7/30 days, or pick dates); search; sort by date or latest added. Each row shows date, time, who, place, and “Added … by …”. | browser check |
| Setup guide | People who join (new family or by invite) get a 3-step guide the first time they open the app: bring in calendars (school/ParentSquare link, Google, Outlook, Apple, or a PDF/photo), add family members, then add to home screen + notifications. Skip any time; reopen from More → Setup guide. | API test + browser check |
| Home-screen prompt | Today shows “Get the Family Flow app” until it’s installed. Android/Chrome: one tap opens the install prompt. iPhone: shows the Share → Add to Home Screen steps (websites can’t self-install on iOS). “Not now” hides it for 10 days. | browser check (iPhone user agent) |
| Password reset | Owner: People → Edit → “Send a password reset link” (adults can do it for children’s logins). The one-time link (48 h) opens “Choose a new password”, signs them in and signs out their other devices; older links stop working. Sign-in screen has “Forgot password?” explaining this. | `test/reset.test.js` + browser check |
| Join alerts | When someone joins the family (invite link) or a family group (group link), everyone else gets a “Hayley joined “Nuclear family”” alert in the inbox and as a push (respects the Family updates switch). | `test/join.test.js` |
| Stuck-loading repair | App files always come fresh from the network (saved copy only offline), so old and new files can’t mix. If the app still hasn’t started after 8 s, the loading screen offers “Refresh the app”, which clears the saved copy and reloads. | browser check (blocked file) |
| Resend app link | People & invites → “Send link” gives someone who already joined the app address, their sign-in email and iPhone install steps (copy or share). | browser check |
| Profiles & labels | No placeholder profiles. Signing up (or joining by invite) creates your own profile with your name, plus an optional label for how you show up (Mom, Dad, Grandma…). Labels are used across the app, alerts, the assistant and the calendar feed. One login per profile; “Which profile is me?” to change. Tests seed a demo family (`signedUp({ demo })`); `e2e/smoke.mjs` still assumes the old demo names. | `test/groups.test.js`, `test/api.test.js` |
| Diagnostics | Owner-only page of live checks: database write/read, schema, cron heartbeat, overdue reminders, push, backups, Geoapify, Photon, Claude API key + model, Workers AI. A check is only green if it actually ran and passed. | `test/ops.test.js` |

## Not done yet (honest list)

- **Two-way editing of Google/Outlook events.** (One-tap "Sign in with Google / Microsoft" import is built; it switches on when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and `MS_CLIENT_ID`/`MS_CLIENT_SECRET` are set.) Earlier note: Import today uses private iCal links (no app approval needed). Signing in instead of pasting a link, faster updates, and editing Google/Outlook events from Family Flow need a Google Cloud app (Google verification for calendar access) and a Microsoft Entra app registration. Phase 2.
- Some work/school accounts block the private iCal link (Google Workspace) or calendar publishing (Microsoft 365); then import isn't possible until the IT admin allows it or Phase 2 sign-in exists.
- Imported events cover 60 days back to 400 days ahead.
- **Email** (self-service password reset, invite emails). No email provider yet: a forgotten password is handled by a reset link the owner sends (People → Edit → “Send a password reset link”). Invite links are shared by copy/share.
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
MOCK_AI=1 MOCK_PLACES=1 MOCK_VOICE="milk, eggs and bread" node scripts/dev-server.js 8787 /tmp/dev.sqlite
node e2e/smoke.mjs http://localhost:8787   # browser test (needs Playwright installed)
```

If you change `src/lib/time.js`, copy it to `public/js/time.js` (a test checks they match).

## Layout

```
src/index.js            routes, security headers, cron entry
src/lib/                auth, database helpers, time zones + recurrence, reminders, Web Push
src/routes/             account, calendar+tasks, places, assistant+voice, ops (inbox, push, cron, backups, diagnostics)
migrations/             D1 schema (src/lib/schema.js also adds new columns/tables itself on first request, so deploys work with or without the migrations step)
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
