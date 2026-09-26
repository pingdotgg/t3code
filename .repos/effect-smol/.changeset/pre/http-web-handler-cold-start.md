---
"effect": patch
---

Reduce cold start cost of `HttpRouter` and `HttpEffect` web handlers.

- `HttpServerRespondable` no longer imports `Schema` to detect schema errors, which removes the Schema modules from bundles that do not otherwise use them (about 23% of a minimal `HttpRouter` bundle).
- `HttpRouter.toWebHandler`, `HttpEffect.toWebHandlerLayer` and `HttpEffect.toWebHandlerLayerWith` now build the layer immediately instead of on the first request. A failed build never surfaces as an unhandled rejection; every request rejects with the build error instead.
