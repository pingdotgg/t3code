---
"effect": patch
---

Transient routing states for persisted cluster messages no longer surface as errors.

If an entity moves runners or is shut down before replying, the caller keeps
waiting for the reply via message storage while the entity moves. If the local
runner is shutting down while a caller is waiting, the call is interrupted
instead of failing with `EntityNotAssignedToRunner`: the request is already
durable and will be served under the next owner.

Durable workflows treat such an interrupt as an abandoned run attempt: the run
stops with nothing persisted, without running compensations or resuming the
parent, ready to replay on the replacement runner.
