# Review usage

The Usage page combines Claude Code, Codex, and OpenCode activity from your connected environments.
It reads the providers' local session history and shows API-equivalent token cost, processed tokens,
cache savings, provider shares, and model breakdowns. It can therefore include work started outside
T3 Code.

Prompt text, responses, and tool output are not sent to the client; environments return only
aggregated usage totals. Subscription billing is separate from the raw token cost shown here. When a
provider records a cost, T3 Code uses it. Otherwise, it estimates cost from the available model rate
table and marks models it cannot price.

For OpenCode, T3 Code honors `OPENCODE_DB` and discovers databases created by channel installs in
OpenCode's data directory. In-memory OpenCode databases cannot be inspected by another process.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

When multiple connected environments point to the same provider data on one machine, T3 Code counts
that source once to avoid duplicate totals.
