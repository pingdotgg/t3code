# Understanding usage

The Usage page estimates token use and cost from the histories written by your coding providers.
Choose 7, 30, or 90 days, switch between cost and tokens on the chart, or select a provider in the
legend to focus the whole page on it.

T3 Code reads usage from Claude Code, Codex, Grok, and OpenCode. Grok coverage is partial because
interactive sessions do not always save usage updates. Cursor does not currently expose a durable
token ledger that T3 Code can scan.

When you connect more than one environment, **All environments** combines their results. T3 Code
recognizes environments that read the same provider history and counts that source only once. Use
the environment selector to inspect one machine by itself.

Costs reported directly by a provider take priority. Otherwise, T3 Code estimates cost from the
model's public API rate when one is available. The total is therefore a usage estimate, not an
invoice, and subscription plans may differ from the displayed raw token cost.

The coverage notice explains missing, partial, duplicated, or incompatible sources. Updating an
older environment can restore sources excluded because its usage format is no longer compatible.
