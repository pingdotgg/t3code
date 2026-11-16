# Context handoffs

Portable provider handoffs select saved history within a context budget. Selected user and assistant
messages retain their complete text and roles; activity is attributed as context. Generated
conversation summaries may stand in for older items when the project has opted in, but only after
their sources are revalidated and every range of a replaced item is covered. The lookup offers the
coarsest current summaries that do not overlap, and delivery tries them by covered items per byte,
accepting one only when more history items arrive with it than without it, counting verbatim and
summarized items alike. The six newest messages are never traded away,
which matches the tail the summary pass never covers. A summary's sources must all be carried by the
handoffs, with one exception that only the caller can declare. A recovery replays every earlier run
of its thread onto a fresh native conversation but reads history without MCP tool results, so the
caller names those runs and a summary may cite history inside them. Nothing is inferred from a
handoff record: it does not name the thread its run ordinals describe, and a fork's history spans
its ancestors. These transfers do not
reconstruct native provider session state, tool state, approvals, or attachments.

Within a provider handoff payload, selected evidence is stored in `history.messages`. The
`summaryText` field carries a compact coverage and recovery receipt, which also appears in the
handoff activity item. It does not repeat the selected message or tool-output bodies. Delivery
reads the intact evidence from `history`, preserving the same selection and context budget.

Fork merge-back and side-chat fallback text use `compactText` for compact item descriptions. Its
240-character prefix is a property of those fallback descriptions, not the provider handoff history
budget. Omitted history remains discoverable through the handoff's thread and item references.

Provider handoffs use either the full eligible app history or the delta since that provider last
participated. Fork merge-back handoffs summarize eligible delta items from the child.

Project-knowledge and conversation-summary references must revalidate their cited sources before
expansion or replay into a new provider history. Deleted threads/projects, rolled-back runs, and
digest mismatches make evidence unavailable; durable facts remain, but retained delivery excerpts
are scrubbed by bounded, model-free maintenance after removal commits, even if nobody reads the
receipt. Read-time revalidation remains the safety net; references and digests survive, not the
removed excerpts. Derived summary statements are excluded on revalidation. Archive is reversible
visibility, not removal.
Projection rebuilds replay deletion, correction, and run-state events in order, so the final
projection applies the same exclusion without a second removal registry. Do not interpret this
as recalling copies already sent to a provider.

A roll-up is an ordinary summary whose sources are four adjacent summaries of the same thread. Depth,
roots and the exact ranges beneath a roll-up are derived from the rows on every pass and read, never
stored, so there is no second owner of structure or validity to keep in sync. A roll-up is current
only while every range beneath it is; a stale leaf therefore withholds its ancestors' text, and the
pass deletes a dead roll-up (unless a handoff references it) so its current children become roots
again. The pass rolls up a run of four current roots when that run ends before the first uncovered
gap, and makes a new leaf only after those runs. A gap keeps the roots on its far side out of
that run, so the neighbours of a replaced leaf never roll up without the replacement. Rolling
them up early would summarize more than the broken path, which could then not be rebuilt alone.
A stretch is skipped after two unusable summaries, and a failure counts only when another summary
succeeds in the same pass, so an outage skips nothing. A skipped stretch gets no leaf, so it is not
a gap and roll-ups proceed past it; delivery replays its items in full. Skips are keyed by the
summary model, and turning summaries back on for the project clears them.
A roll-up offer carries no delivered-knowledge evidence, unlike a leaf offer: the evidence of a few
hundred items would never fit beside it. Roll-ups are capped by rendered bytes, as delivery
measures them, so several fit beside the verbatim tail of a 16 KB handoff.

A context restart replaces a large native conversation with a fresh one seeded by the same
`full_thread_summary` recovery handoff that a failed resume uses (`ContextRestart.ts` holds the
rule, `ProviderTurnStartService` the effects). It exists because cache reads of long histories
dominate cost, and it is shaped by the prompt cache: a restart pays one cache rebuild, so it fires
only at turn start and only when the fresh conversation is estimated at no more than half the
measured context. The estimate is the first usage measured on the current native conversation, which
also makes the turn right after a restart ineligible. Restarts are refused, never forced: the turn
continues natively on any gap (an older item delivered neither verbatim nor beneath a summary), a
queued summary pass, background work, a control message, a restart continuation, or a group
discussion. Native forks and threads held by another client never reach the check, because the fork
path returns first and the resume that precedes it fails. Codex is the only driver for now. A
replacement conversation, from a restart or a recovery, gets the 64,000-byte ceiling at preparation
and delivery, because it has no native history to protect; switches and forks keep the configured
cap. Checkpoint rollback reverts the native conversation each attempt recorded, so rolling back past
a replacement points the thread at the older conversation instead of over-reverting the new one.

Legacy v1 continuation uses a separate algorithm. It considers only user and assistant messages,
walks backward from the newest message, and builds a transcript suffix within a 32,000-character
budget. Do not describe that migration budget as the limit for portable handoffs.

Rolling back across this format is one-way for conversation summaries. An older server cannot decode
summaries with `turn_item` or `summary` sources, or read the renamed `position` column, so its list,
describe, and expand calls return storage errors and its background pass fails on those rows. Summaries are derived data that a current server regenerates,
so this is accepted rather than guarded with a version check or a separate table.
