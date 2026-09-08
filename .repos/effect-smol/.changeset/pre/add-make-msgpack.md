---
"effect": patch
---

Add `RpcSerialization.makeMsgPack` for creating MessagePack serialization with custom msgpackr options. On Cloudflare Workers with `allow_eval_during_startup` (default for `compatibility_date >= 2025-06-01`), pass `{ useRecords: false }` to prevent msgpackr's JIT code generation via `new Function()`, which is blocked during request handling. Also fixes silent error swallowing in the `msgPack` decode path — non-incomplete errors are now rethrown instead of returning `[]`.
