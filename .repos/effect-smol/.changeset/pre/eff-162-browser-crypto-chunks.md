---
"@effect/platform-browser": patch
---

Fix `BrowserCrypto.randomBytes` for requests larger than the Web Crypto per-call limit.
