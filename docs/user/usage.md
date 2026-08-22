# Usage

Open **Settings** → **Usage**. The page opens on **Subscription**, and the segmented control lets
you switch between two independent views:

- **Subscription** shows the current allowance windows reported by each enabled Codex or Claude provider.
- **Historical** shows transcript-derived token activity, date windows, charts, and API-equivalent cost.

Subscription allowance is kept separate from Historical usage, and each provider instance and
environment remains inspectable. T3 Code displays provider-reported percentages, window scopes,
reset times, credits, and spending controls only when the provider supplies them. It does not infer
a quota, reset, account status, or combined cross-provider total.

Use **Refresh** on web or pull down on the mobile Usage screen to request a new provider observation.
The **Updated** timestamp communicates the age of the displayed observation. Data retained after a
failed refresh or passed reset time keeps its existing **Updated** timestamp while it remains
visible. T3 Code does not reset percentages locally.

Leaving the Subscription view stops its live allowance updates; returning to it requests a fresh
reading. If an environment is offline or reconnecting, its last known reading remains identified
by its connection state. Multiple environments and provider instances are shown separately unless
the provider supplies an exact, privacy-safe identity that proves they share one allowance account;
even then, the displayed group uses one whole source and never blends windows from several sources.

When Claude does not provide subscription limits, the Claude section remains visible with this explanation:

> Claude did not report subscription usage limits.

This message does not diagnose the account, subscription, OAuth scope, or provider outage. If a
newer client is connected to an older environment that does not support Subscription, the page
shows an environment compatibility message while Historical remains available. Older clients can
continue using Historical when connected to a newer environment because the new connection methods
are additive.

Historical usage remains available independently of subscription allowance reporting. Subscription
allowance does not add a new analytics stream or expose credentials, raw provider payloads,
transcripts, configuration paths, or unmasked account details.

The Historical view combines Codex and Claude Code activity from connected environments. It reads
local session history and shows API-equivalent token cost, processed tokens, cache savings, provider
shares, and model breakdowns. Subscription billing is separate from the raw token cost shown here.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
