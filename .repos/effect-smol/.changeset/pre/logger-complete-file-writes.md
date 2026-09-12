---
"effect": patch
---

Fix `Logger.toFile` dropping the remainder of a log batch when a successful file write writes only part of the buffer. File logging now uses the complete-write contract; write errors continue to be ignored.
