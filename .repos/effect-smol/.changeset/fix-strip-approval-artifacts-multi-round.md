---
"effect": patch
---

Fix LanguageModel stripping of resolved approval artifacts across multi-round conversations.

Previously, `stripResolvedApprovals` only ran when there were pending approvals
in the current round. Stale artifacts from earlier rounds would leak to the
provider, causing errors. The stripping now runs unconditionally.

In streaming mode, pre-resolved tool results are also emitted as stream parts
so `Chat.streamText` persists them to history, preventing re-resolution on
subsequent rounds.
