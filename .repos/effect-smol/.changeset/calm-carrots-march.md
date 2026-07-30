---
"effect": patch
---

Allow unstable HttpApi middleware to declare multiple error schemas with arrays.

Middleware errors now follow endpoint error behavior for response status resolution, client decoding, and generated API schemas.
