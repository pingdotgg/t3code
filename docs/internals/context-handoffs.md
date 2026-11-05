# Context handoffs

Portable provider handoffs select saved history within a context budget. Selected user and assistant
messages retain their complete text and roles; activity is attributed as context. Generated
conversation summaries may stand in for older items when the project has opted in, but only after
their sources are revalidated and every range of a replaced item is covered. These transfers do not
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

Legacy v1 continuation uses a separate algorithm. It considers only user and assistant messages,
walks backward from the newest message, and builds a transcript suffix within a 32,000-character
budget. Do not describe that migration budget as the limit for portable handoffs.

Rolling back across this format is one-way for conversation summaries. An older server cannot decode
summaries with `turn_item` sources, so its list, describe, and expand calls return storage errors and
its background pass fails on those rows. Summaries are derived data that a current server regenerates,
so this is accepted rather than guarded with a version check or a separate table.
