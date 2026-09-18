---
"@effect/platform-node-shared": patch
"@effect/platform-deno": patch
---

Fix `File.readAlloc` on Node and Deno to fail with `PlatformError` (`BadArgument`) for negative, fractional, non-finite, or unallocatable sizes without moving the cursor. Zero-size reads continue to return `Option.none()` without moving the cursor.
