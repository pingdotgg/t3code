# Usage and limits

## Understand your usage

**Usage** combines Codex, Claude Code, and Grok Build session history from your connected
environments. It shows token use, cache savings, model breakdowns, and estimated API-equivalent
cost. These estimates are not your subscription bill.

Claude Code accounting keeps the final progressive snapshot for each response and prices every
attempt in a model-fallback sequence. Five-minute and one-hour cache writes use their distinct
public rates when the transcript provides the TTL. Thinking tokens remain part of output rather
than being charged twice.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. Changing dates reuses a source snapshot from the last minute when it already
covers the requested range. An older snapshot, or a range that reaches farther back, updates the
source data first. The Refresh action always requests an update. Updates parse only new or changed
transcript content.

Any daily chart zooms: drag across it to make the selection the new date window, and double-click
to return to the preset. The date fields beside the presets accept custom ranges up to 90 days.

The breakdown's **Thread** view drills into where the spend went: sessions group into the T3 Code
thread they belong to, with sessions that never ran through T3 Code listed under the first thing
you asked in them. Grok Build has no trusted prompt title, so its rows use a short session label.
Expanding a row splits its daily model-priced cost into cache writes, cache
reads, and fresh input plus output, alongside any Claude subagents the thread spawned.
Provider-reported totals are not split into estimated components.
Each connected environment contributes at most 40 rows, reserving room to group lower-cost rows
under **Other threads** by provider and project. Those grouped rows stay in the totals, so the
thread view still adds up to the selected project or full summary.
Rows that map to a thread carry a link that opens it.

The **Cache writes, estimated** total prices cache-creation tokens at each model's cache-write rate.
It only applies to model-priced records that report cache-creation tokens. Rows without cache
writes show a dash; incomplete or unavailable pricing is labeled **Unavailable** instead of zero.
Cache creation is a billing category, not evidence that a cache entry expired.
When a Codex rollout reports `cache_write_input_tokens` as zero, T3 Code cannot reconstruct a
separate write charge; those prompt tokens remain in **Fresh input + output**.

Usage is attributed to the project whose folder a session ran in, including sessions driven
outside T3 Code. The breakdown's **Project** view ranks projects by spend, and the project picker
narrows the whole page to one project; work that ran outside every project is grouped under
"Outside projects". Grok Build sessions record no folder, so they remain in overall totals but are
omitted from the project breakdown and project filters.

Totals depend on the history available on each server. Grok turns without a saved completed-turn
record are missing from the totals.

On web and desktop, use the environment dropdown to filter costs, tokens, and limits. All
environments are selected by default. The dropdown shows which environments are still scanning;
results appear as each one responds.

If recent work is missing or a new model shows no cost, refresh to rescan session history and
update model pricing.

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter;
choose all environments or select individual destinations. Enter the exact model ID and USD
rates per million input and output tokens. You can enter any model ID, including models
without public pricing.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. When environments have different prices,
cells show **Mixed**. Edit rates directly in the table, then choose **Save changes** to apply all
edited rows. Untouched cells keep each environment's rate. Select one environment to inspect its
prices. **Reset to automatic** marks a model's override for removal when you save; you can undo
it before saving.

Each destination reports whether the change saved. Offline or unavailable environments are
marked **Not saved**. Reconnect them and choose **Retry failed saves** to finish the same change
without writing again to environments that already saved. Changes are not queued after you close
the dialog.

## Track subscription limits

**Usage → Limits** shows quota use and reset times for Codex and Claude subscriptions. It also
compares quota consumed with time elapsed in each window, so you can judge your pace before the
next reset.

If a window looks stale, refresh Limits to re-check every provider and hub.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The accounts appear under **Usage → Limits**. This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.
