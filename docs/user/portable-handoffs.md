# Context in portable handoffs

T3 Code sometimes starts a fresh provider session instead of resuming a provider's native session.
This happens when you switch providers, continue through portable restart steering, or use a fork
that the provider cannot resume itself.

The new provider receives a text handoff. This handoff is useful context, but it is not a copy of
the original provider session. For each included user message, assistant message, command, or prior
handoff, T3 Code collapses whitespace and keeps up to 240 characters from the beginning. File
changes appear by filename, and checkpoints appear with a file count. Other timeline items may not
appear in the handoff.

Text near the end of a long message can be omitted. Before switching providers or continuing a
portable fork, put the current goal, hard constraints, and any unresolved failure in a short message.
You can also paste the exact detail again after the new provider starts.

This 240-character rule is different from migration of older threads. A migrated thread gives its
first fresh provider session the newest transcript suffix within a separate 32,000-character budget.
See [Threads from older T3 Code versions](./thread-migration.md) for that migration path.
