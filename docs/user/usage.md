# Review usage

The Usage page combines Codex and Claude Code activity from your connected environments. It reads
the providers' local session history and shows API-equivalent token cost, processed tokens, cache
savings, provider shares, and model breakdowns. Subscription billing is separate from the raw token
cost shown here.

On web and desktop, enable **Show plan usage in sidebar** under **Settings → General** to put the
highest provider-reported subscription utilization beside the Usage icon. The number is muted below
70%, amber from 70%, and red from 90%. Hover it to see every reported limit, including separate
weekly model limits such as Claude Fable when the provider supplies them. Plan limits refresh with
provider health checks and disappear when a provider or account cannot report subscription usage.
Codex and Claude currently report plan limits; other providers keep the normal icon-only link.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
