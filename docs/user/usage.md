# Review usage

The Usage page combines Codex, Claude Code, and Grok activity from your connected environments. It reads
the providers' local session history and shows API-equivalent token cost, processed tokens, cache
savings, provider shares, and model breakdowns. Subscription billing is separate from the raw token
cost shown here.

![Usage report with simulated Grok activity](./assets/usage-report-grok-simulated.jpeg)

_Example report with randomized simulated Grok data._

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

Each environment sends only aggregated time buckets to the client. If several environments point at
the same transcript directory, T3 Code counts that directory once.

Some providers include exact costs in their transcripts. For records without one, T3 Code estimates
cost from known model rates; unknown models remain visible in token totals and are marked unpriced.
