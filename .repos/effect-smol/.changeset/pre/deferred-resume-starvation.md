---
"effect": patch
---

Fix `Deferred` completion skipping waiters when an earlier waiter dies during resume. Completing a `Deferred` with an interrupt cause kills a suspended waiter synchronously inside its resume; the dying waiter's `await` cleanup spliced the shared `resumes` array mid-iteration, so the next waiter was never resumed and hung forever. Completion now clears `resumes` before resuming waiters.
