# Review usage

The Usage page combines Codex and Claude Code activity from your connected environments. It reads
the providers' local session history and shows API-equivalent token cost, processed tokens, cache
savings, provider shares, and model breakdowns. Subscription billing is separate from the raw token
cost shown here.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

## Review subscription limits with Vibe-Proxy

Open **Settings > Usages** on web or mobile to connect a Vibe-Proxy
management API. Enable the integration, enter the server's base URL, and save its management key.
The key is stored by the connected T3 Code server and is never returned to the client.

The page refreshes account limits whenever you open it. The last successful result stays available
while a refresh runs and remains visible if Vibe-Proxy is temporarily unreachable. Each account
shows its provider, status, quota windows, reset times, and recent request health when Vibe-Proxy
reports those fields.
