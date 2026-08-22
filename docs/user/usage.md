# Review usage

The Usage page combines Codex, Claude Code, and Kimi Code activity from your connected environments. It
reads the providers' local usage history and shows API-equivalent token cost, processed tokens,
cache savings, provider shares, and model breakdowns. Subscription billing is separate from the raw
token cost shown here. Kimi Code's terminal UI and desktop app use separate session homes; T3 Code
scans both and combines their turn-scoped usage without double counting shared environments.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

If an environment cannot read one of its provider stores, the page keeps any available usage and
shows that coverage is incomplete. A healthy environment reading the same physical store can
supply the missing coverage without double counting it.
