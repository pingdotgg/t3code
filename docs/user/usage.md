# Review usage

The Usage page combines Codex, Claude Code, Grok Build, and OpenCode activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

OpenCode totals come from completed assistant messages in its local SQLite database. T3 Code reads
only usage metadata such as timestamps, model IDs, token counts, and cost; prompt and response
content stays in the database. If OpenCode reports no cost for a subscription-backed model, the
page uses its API-equivalent model rate when one is available.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
