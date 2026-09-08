---
"effect": patch
"@effect/platform-browser": patch
"@effect/platform-node": patch
---

Vendor the multipart parser as `effect/unstable/http/MultipartParser`, add the Node.js adapter at `@effect/platform-node/NodeMultipartParser`, and remove the external `multipasta` dependency.
