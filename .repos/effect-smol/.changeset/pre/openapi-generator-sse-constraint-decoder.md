---
"@effect/openapi-generator": patch
---

Fix the generated SSE `sseRequest` helper to reference `Schema.ConstraintDecoder` instead of the no-longer-exported `Schema.Decoder`.

For specs with `text/event-stream` responses the generator emitted a helper typed as `Schema.Decoder<Type, DecodingServices>`, but `Schema` exports that decode-only interface as `ConstraintDecoder`, so generated clients failed to compile (`'"effect/Schema"' has no exported member named 'Decoder'`). The emitted helper now uses `Schema.ConstraintDecoder`.
