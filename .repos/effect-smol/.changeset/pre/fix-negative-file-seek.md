---
"effect": patch
"@effect/platform-node-shared": patch
"@effect/platform-deno": patch
---

On Node and Deno, `FileSystem.File.seek` now rejects negative resulting positions with a `BadArgument` platform error, leaving the cursor unchanged. Its return type is now `Effect<bigint, PlatformError>`.
