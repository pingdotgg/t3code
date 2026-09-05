# Usage and limits

## Understand your usage

**Usage** combines Codex, Claude Code, and Grok Build session history from your connected
environments. It shows token use, cache savings, model breakdowns, and estimated API-equivalent
cost. These estimates are not your subscription bill.

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
Expanding a row shows its daily estimated cost, along with any Claude subagents the thread spawned.
Each connected environment contributes at most 40 rows, reserving room to group
lower-cost rows under **Other threads** by provider and project. Those grouped rows stay in the
totals, so the thread view still adds up to the selected project or full summary.
Rows that map to a thread carry a link that opens it.

Usage is attributed to the project whose folder a session ran in, including sessions driven
outside T3 Code. The breakdown's **Project** view ranks projects by spend, and the project picker
narrows the whole page to one project; work that ran outside every project is grouped under
"Outside projects". Grok Build sessions record no folder, so they remain in overall totals but are
omitted from the project breakdown and project filters.

Totals depend on the history available on each server. Grok turns without a saved completed-turn
record are missing from the totals.

If recent work is missing or a new model shows no cost, refresh to rescan session history and
update model pricing.

## Set custom model prices

On web or desktop, open **Usage → Model prices** to add, edit, or remove a model's estimated
price. Choose the environment whose history you want to price, then enter the exact model ID and
USD rates per million input and output tokens. You can enter any model ID, including models
without public pricing.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. Set prices on each environment that needs
them. Removing a price restores automatic pricing.

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
