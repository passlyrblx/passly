# Passly

Roblox donation room platform.

## Discord OAuth on Render

Passly supports both Roblox and Discord login. Discord login uses OAuth2 scopes `identify` and `guilds`, stores the Discord user ID, username, avatar URL, and guild list in MongoDB, and lets players link Roblox later from **Profile** so donation/gamepass features can still verify Roblox ownership.

### Render environment variables

In your Render service dashboard, open **Environment** and add these variables:

- `MONGO_URI` — your MongoDB connection string.
- `JWT_SECRET` — a long random secret used to sign Passly sessions.
- `DISCORD_CLIENT_ID` — Discord application client ID.
- `DISCORD_CLIENT_SECRET` — Discord application client secret.
- `DISCORD_REDIRECT_URI` — your production callback URL: `https://YOUR-RENDER-SERVICE.onrender.com/auth/discord/callback`.
- `ROBLOX_CLIENT_ID` — Roblox OAuth client ID.
- `ROBLOX_CLIENT_SECRET` — Roblox OAuth client secret.
- `ROBLOX_REDIRECT_URI` — your production callback URL: `https://YOUR-RENDER-SERVICE.onrender.com/auth/roblox/callback`.
- `VIP_GAMEPASS_ID` — optional Roblox VIP gamepass ID.
- `PORT` — Render sets this automatically; do not override it unless you know you need to.

After saving the variables, redeploy the Render service so the Node.js process receives the new values.

### Discord Developer Portal redirect URI

In the Discord Developer Portal for your application, add the exact same redirect URL that you put in Render:

```text
https://YOUR-RENDER-SERVICE.onrender.com/auth/discord/callback
```

For local development you can use:

```text
http://localhost:3000/auth/discord/callback
```

## Database configuration

Passly now keeps MongoDB for chat/room/activity/notification-style data and uses Supabase PostgreSQL for structured account and economy data. Configure these server-side environment variables only; never expose `DATABASE_URL`, `SUPABASE_SECRET_KEY`, or `mongo_URI` in browser code:

- `mongo_URI` (or legacy `MONGO_URI`) — MongoDB connection string for rooms, messages, logs, notifications, and fallback migration reads.
- `SUPABASE_URL` — Supabase project URL.
- `SUPABASE_ANON_KEY` — Supabase anon key for server integrations that need it.
- `SUPABASE_SECRET_KEY` — Supabase service-role key for server-only Supabase SDK operations.
- `DATABASE_URL` — pooled PostgreSQL connection string used by the server for structured reads/writes.

On startup, when `DATABASE_URL` is present, the server creates the PostgreSQL tables/indexes and copies existing MongoDB users, Roblox profile data, balances, donations, purchases, gamepass boards, coupons, and leaderboard source totals into PostgreSQL without deleting MongoDB records. You can also run the migration explicitly with `npm run migrate:postgres`.
