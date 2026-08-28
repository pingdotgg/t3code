# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

The **Limits** view shows how much of each subscription plan's rate windows is currently used,
with reset countdowns per window. Limit info is only available for subscription sign-ins: API-key
authentication is billed per token and has no rate windows, so those providers show a notice
instead. Claude Code, Codex and Grok report limits today; other providers will follow.
