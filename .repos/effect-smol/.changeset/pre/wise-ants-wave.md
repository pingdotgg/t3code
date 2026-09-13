---
"effect": patch
---

Fix `AtomHttpApi.query` to forward v4 `params` / `query` request fields to `HttpApiClient` at runtime.
Also align `AtomHttpApi` endpoint type inference with v4 `HttpApiEndpoint` params/query naming and add a regression test.
