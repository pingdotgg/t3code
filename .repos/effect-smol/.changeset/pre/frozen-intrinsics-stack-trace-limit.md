---
"effect": patch
---

Avoid throwing when `Error.stackTraceLimit` is non-writable (frozen intrinsics / SES / deterministic sandboxes such as Temporal).

Effect manipulates `Error.stackTraceLimit` in several internal spots to capture short or empty stack traces cheaply. In hardened environments where `Error` is frozen and `stackTraceLimit` is read-only, assigning to it throws, which broke Effect entirely. Stack-trace-limit manipulation is now best-effort and silently no-ops when the property cannot be modified, mirroring Node's own internal guard. Behavior in normal (writable) environments is unchanged.
