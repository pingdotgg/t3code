---
"effect": patch
---

Fix DevToolsClient not flushing final span events on teardown.

The stream consumer was `forkScoped`, causing it to be interrupted before
it could drain remaining queue items. Replaced with `forkChild` and
`Fiber.await` in the finalizer so the stream drains naturally after the
queue is failed.
