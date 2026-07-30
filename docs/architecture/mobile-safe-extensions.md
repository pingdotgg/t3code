# Mobile-safe Forma extensions

Forma uses the upstream v0.0.31 environment protocol so the official T3 Code
mobile app can connect directly to a Forma server. Fork-only behavior therefore
lives beside the upstream thread model instead of widening its required fields.

## Compatibility boundary

The required upstream interaction mode remains `"default" | "plan"`. Ask mode
is advertised separately in provider presentation and stored in
`thread_extension_state`. A turn that uses Ask still carries `"default"` in its
standard interaction-mode field and an optional Forma Ask override in its
extension input.

The persistent turn queue also lives outside `projection_threads`, in
`projection_thread_turn_queue`. Queue and fork events are internal server
events. Standard shell and thread subscriptions coalesce their effects into
ordinary upstream-shaped snapshots and never stream an unknown event variant.
Mobile sees queued input only after it is promoted as a normal user message,
and sees a fork as an ordinary newly-created thread.

Forma clients discover optional functionality through additive environment
capabilities and use separate RPCs for extension state, queue mutations,
forking, project-local agents, component previews, versioned files, and
workspace mutations. A v0.0.31 client ignores those optional descriptor fields.

## Settlement and recovery

Queue promotion is serialized and receipt-driven. A queued turn is eligible
only after the provider session is idle and turn, checkpoint, diff, and
settlement work have all completed. Interruptions and provider start failures
pause the queue. Startup reconciliation preserves pending items and resumes
only queues which were explicitly running.

Legacy PR #1 databases reused migration IDs 26–31 for different operations.
Migration 38 idempotently replays the upstream schema effects, canonicalizes
model selections, converts mobile-visible legacy `"ask"` values to
`"default"`, and rebuilds only obsolete role-based authorization tables.
Rebuilding those legacy authorization tables invalidates old pairing sessions,
so affected clients must pair again. Current scoped authorization state is
preserved. Migration 39 preserves legacy queued prompts but restores them
paused with the reason `migration`.

User data is not moved automatically. Existing installations should still move
`~/.forma` to `~/.t3` manually when adopting the renamed runtime directory.
