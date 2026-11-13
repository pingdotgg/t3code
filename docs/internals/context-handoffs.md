# Context handoffs

Portable provider and fork handoffs are textual summaries. They do not claim native provider context
parity.

`ContextHandoffServiceV2` includes user messages, assistant messages, command executions, file
changes, checkpoints, and prior handoffs. It skips other turn item types. For text-bearing items,
`compactText` replaces every whitespace run with one space, trims the result, and returns at most
240 characters. A truncated value contains the first 237 characters followed by `...`. File changes
carry the filename, while checkpoints carry only the number of files.

Provider handoffs use either the full eligible app history or the delta since that provider last
participated. Fork merge-back handoffs summarize eligible delta items from the child. Neither path
reconstructs provider-native session state, tool state, approvals, or omitted text.

A native goal stays with the session that owns it. Delivery names every unfinished goal held by
another native session of the thread, in the context that is never trimmed. For a live session it
reads the goal from the provider thread at delivery and not from a handoff record: a retained
handoff is delivered again later, and a stored copy would then announce a goal that has since been
cleared. A failed resume is the exception. The replacement session overwrites the provider thread
row, so the recovery handoff records the displaced session's goal as `displacedGoal`, and delivery
keeps naming it until a `/goal` objective or `/goal clear` on that provider decides it.

Legacy v1 continuation uses a separate algorithm. It considers only user and assistant messages,
walks backward from the newest message, and builds a transcript suffix within a 32,000-character
budget. Do not describe that migration budget as the limit for portable handoffs, and do not describe
the 240-character prefix as a migration rule.
