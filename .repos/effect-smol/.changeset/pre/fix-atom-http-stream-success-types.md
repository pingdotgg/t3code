---
"effect": patch
---

Match `AtomHttpApi` query and mutation success types to the generated HTTP client,
including SSE, binary streams, and header-wrapped responses. Stream transport,
decoding, and SSE errors now appear in the stream's error channel instead of
`never`, so code that assumed a failure-free stream may need to handle them.
Runtime and serialization behavior are unchanged.
