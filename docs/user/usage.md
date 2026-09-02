# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. Changing dates reuses a source snapshot from the last minute when it already
covers the requested range. An older snapshot, or a range that reaches farther back, updates the
source data first. Updates parse only new or changed transcript content.

Any daily chart zooms: drag across it to make the selection the new date window, and double-click
to return to the preset. The date fields beside the presets accept any custom range directly.
