---
"effect": patch
---

Allow Schema decoding defaults to require Effect services.

The `Effect` passed to `Schema.withDecodingDefault`, `Schema.withDecodingDefaultKey`, `Schema.withDecodingDefaultType`, and `Schema.withDecodingDefaultTypeKey` now accepts a context `R` in its third type parameter. The required services are propagated into the resulting schema's `DecodingServices`. `SchemaGetter.withDefault` is widened in the same way.
