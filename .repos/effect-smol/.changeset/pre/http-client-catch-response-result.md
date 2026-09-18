---
"effect": patch
---

Constrain the data-first `HttpClient.catch(client, recover)` overload to recover with
`HttpClientResponse` values, matching the data-last overload. Callbacks returning other
success types are now rejected; use `Effect.catch` on the result of `client.execute(request)`
to recover to arbitrary values.
