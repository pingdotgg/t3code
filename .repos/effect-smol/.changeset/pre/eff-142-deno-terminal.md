---
"@effect/platform-deno": patch
"@effect/platform-node-shared": patch
---

Add a Deno `Terminal` implementation and keep `NodeTerminal` input readers alive until stdin ends under Deno.
