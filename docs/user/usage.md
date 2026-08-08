# Review usage

The Usage page estimates token use and cost from the histories written by your coding providers.
It reads Claude Code, Codex, Grok, and OpenCode session history and shows API-equivalent token
cost, processed tokens, cache savings, provider shares, and model breakdowns. Grok coverage is
partial because interactive sessions do not always save usage updates. Cursor does not currently
expose a durable token ledger that T3 Code can scan. Subscription billing is separate from the
raw token cost shown here.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment. Select a provider in the
legend to focus the whole page on it.

When you connect more than one environment, **All environments** combines their results. T3 Code
recognizes environments that read the same provider history and counts that source only once. Use
the environment selector to inspect one machine by itself.

Costs reported directly by a provider take priority. Otherwise, T3 Code estimates cost from the
model's public API rate when one is available. The total is therefore a usage estimate, not an
invoice, and subscription plans may differ from the displayed raw token cost.

The coverage notice explains missing, partial, duplicated, or incompatible sources. Updating an
older environment can restore sources excluded because its usage format is no longer compatible.
