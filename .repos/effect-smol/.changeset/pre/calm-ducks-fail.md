---
"@effect/platform-node-shared": patch
---

Wake `NodeStream.pipeThroughDuplex` readers when the upstream fails so the original error is propagated instead of hanging.
