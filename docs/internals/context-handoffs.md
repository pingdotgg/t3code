# Context handoffs

Portable provider and fork handoffs are textual summaries. They do not claim native provider context
parity.

`ContextHandoffServiceV2` includes user messages, assistant messages, command executions, file
changes, checkpoints, and prior handoffs. It skips other turn item types. For text-bearing items,
`compactText` replaces every whitespace run with one space, trims the result, and returns at most
240 characters. A truncated value contains the first 237 characters followed by `...`. File changes
carry the filename, while checkpoints carry only the number of files.

Provider handoffs use either the full eligible app history or the delta since that provider last
participated. Fork merge-back handoffs summarize eligible delta items from the child. A seat
handover (`freshContext` with `contextHandoffOnFresh`, UI: Start fresh with recap / `/recap`) also
builds a full-thread summary into a new provider session. That is not Compact (same native session)
and not Clear / `/clear` (fresh with no written history). Neither path reconstructs provider-native
session state, tool state, approvals, or omitted text.

Honest restore language (restart recovery) treats a fresh start as fresh, not resumed. Cross-driver
runtime seat switches reuse portable handoffs for a different harness; this same-seat handover keeps
the thread and model selection and only rotates the provider session.

Legacy v1 continuation uses a separate algorithm. It considers only user and assistant messages,
walks backward from the newest message, and builds a transcript suffix within a 32,000-character
budget. Do not describe that migration budget as the limit for portable handoffs, and do not describe
the 240-character prefix as a migration rule.
