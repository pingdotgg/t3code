# Review usage

The Usage page combines Claude Code, Codex, and Cursor activity from your
connected environments. It shows API-equivalent token cost, processed tokens,
cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

| Provider     | Source |
| ------------ | ------ |
| Claude Code  | Local Claude session transcripts under the Claude home |
| Codex        | Local Codex session transcripts under the Codex home |
| Cursor       | Cursor dashboard usage export (requires Cursor desktop signed in on that environment) |

Totals include work done outside T3 Code when the provider writes its own
session history (Claude and Codex) or when Cursor reports usage for the signed-in
desktop account.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period.
The **7 days**, **30 days**, and **90 days** ranges use daily resolution. Cost
and token toggles update both the headline and chart, and refreshing rescans
every connected environment.

Cost figures are API-equivalent estimates from provider-reported dollars when
present, otherwise from a shared model rate table. They are not subscription
charges. Cursor rows billed as included on the plan still contribute tokens and
are priced at API-equivalent rates: Cursor's published Auto Cost / Composer /
Grok rates for those product models, and the underlying model API rate for
third-party Cursor export names (effort and thinking suffixes stripped). Auto
Balance / Intelligence may differ from Auto Cost when Cursor routed to another
model — the export does not say which Auto mode ran.

## Cursor coverage

Cursor agent transcripts on disk do not include token counts. T3 Code reads
usage from Cursor's own export when the environment machine has Cursor desktop
installed and signed in. That uses the desktop session on the machine running
the T3 Code server — the same host-trust model as scanning Claude or Codex
homes. Any client paired to that environment can see the resulting usage.
Environments without that desktop login show Cursor as uncovered and still
report Claude and Codex normally.
