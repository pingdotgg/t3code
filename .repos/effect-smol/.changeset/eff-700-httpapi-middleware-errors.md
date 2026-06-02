---
"effect": patch
---

Improve unstable HttpApi runtime failures for missing server middleware and missing group implementations.

- HttpApiBuilder.applyMiddleware now resolves middleware services via Context.getUnsafe, so missing middleware fails with a clear "Service not found: <middleware>" error instead of an opaque is not a function TypeError.
- HttpApiBuilder.layer now reports missing groups with actionable context (group identifier, service key, suggested HttpApiBuilder.group(...) call, and available group keys).
- Added regression tests in packages/platform-node/test/HttpApi.test.ts covering:
  - addHttpApi + API-level middleware applied across merged groups
  - missing middleware service diagnostics
  - missing addHttpApi group layer diagnostics
