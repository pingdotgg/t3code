---
"effect": patch
---

Include the model's decoding services in the public requirements of `SqlModel.makeResolvers().insert`, alongside its existing input-encoding services.

This intentionally tightens compile-time checking: previously accepted callers must now provide the services already needed to decode inserted rows at runtime. Provide those services when executing the insert with `SqlResolver.request`. `insertVoid` still requires only input-encoding services, and service-free models need no changes. Runtime behavior is unchanged.
