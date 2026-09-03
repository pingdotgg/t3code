# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows a public-list-rate estimate,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from this local estimate.

Claude Code accounting keeps the final progressive snapshot for each response and prices every
attempt in a model-fallback sequence. Five-minute and one-hour cache writes use their distinct
public rates when the transcript provides the TTL. Applicable long-context tiers use each
request's recorded input-token total. Thinking tokens remain part of output rather than being
charged twice.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

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
When a Codex rollout reports `cache_write_input_tokens` as zero, T3 Code cannot reconstruct a
separate write charge; those prompt tokens remain in **Fresh input + output**.
Cache creation is a billing category, not evidence that a cache entry expired.

Usage is attributed to the project whose folder a session ran in, including sessions driven
outside T3 Code. The breakdown's **Project** view ranks projects by spend, and the project picker
narrows the whole page to one project; work that ran outside every project is grouped under
"Outside projects". Grok Build sessions record no folder, so they remain in overall totals but are
omitted from the project breakdown and project filters.
