---
"effect": patch
---

Relax `HttpApiClient.urlBuilder` to accept `HttpApi.Any` instead of requiring `HttpApi.AnyWithProps`.
This allows use in helpers generic over `HttpApi.Any` while preserving inferred URL builder types.
