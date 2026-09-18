---
"@effect/platform-browser": patch
---

Return a typed `PlatformError` from `BrowserCrypto` digest operations when `crypto.subtle` is unavailable, instead of failing with a defect.
