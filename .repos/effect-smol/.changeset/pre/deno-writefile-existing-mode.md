---
"@effect/platform-deno": patch
---

Fix `FileSystem.writeFile` on Deno to preserve permissions when writing an existing file with an explicit mode.
