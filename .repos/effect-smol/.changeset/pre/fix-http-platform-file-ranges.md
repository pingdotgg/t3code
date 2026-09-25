---
"effect": patch
---

Clamp HttpPlatform file response ranges to the file size so Content-Length matches the bytes available. Oversized reads stop at EOF, and offsets at or past EOF return an empty body with Content-Length 0. Apply the same clamping to the default Web file response implementation.
