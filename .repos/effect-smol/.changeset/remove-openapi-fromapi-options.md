---
"effect": patch
---

Remove the `options` parameter from `OpenApi.fromApi`.

The parameter only carried `additionalProperties`, but the function caches results in a `WeakMap` keyed solely on the `api` instance. Passing different options across calls for the same api was silently ignored, making the parameter order-dependent and effectively single-shot. No call sites were using it, so the signature is now simply `fromApi(api)`.
