# Trackers

Habit/health tracker for you and invited friends & family: meds, minoxidil, skincare, study,
books, 1–5 ratings, bad habits, and a daily mood + diary. Works offline and sends reminders.

A Cloudflare Worker serves the mobile web app in `public/` and an API backed by D1 (`trackers-db`).
A cron trigger runs every minute to send Web Push reminders (`src/push.js`, no dependencies).

- Local: `npm run dev` (first visit asks to set up an account; the "old app password" is `dev`, from `.dev.vars`)
- Deploy: `npm run deploy` (migrations → deploy → commit & push to GitHub). Optional message: `npm run deploy -- "what changed"`
- Backup: Manage → Export my data, or `wrangler d1 export trackers-db --remote --output backup.sql`

Accounts: the first account is the owner (proves ownership with the `APP_PASSWORD` secret and
inherits pre-accounts data). Others join with single-use invite links the owner creates in Manage.

Secrets (not in git): `APP_PASSWORD` (only used for first-time owner setup), `VAPID_PRIVATE_JWK`.
