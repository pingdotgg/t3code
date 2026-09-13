---
"effect": patch
---

Fix `HttpRouter.Middleware.layer` to provide request error services for errors declared in `handles`, and expose global
middleware errors from `HttpRouter.toHttpEffect`.
