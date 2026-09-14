---
"effect": patch
---

Refine `Config` loading and absence semantics. `Config.schema` now derives a provider loading policy from the encoded `StringTree` schema, materializes mixed-shape union members independently, and leaves separated scalar parsing to `Config.Array` and `Config.Record`. Schemas whose canonical `StringTree` encoding remains opaque, such as `Schema.Any`, `Schema.Unknown`, or `Schema.Json`, are rejected when the config is constructed; use a concrete shape or `Schema.fromJsonString(Schema.Json)` for scalar JSON. Missing or unavailable representations are decoded as `undefined` before `Config.withDefault` and `Config.option` decide absence. Partially supplied `Config.all` groups are rejected, successful values such as `undefined` and explicitly present empty structures are preserved, and the internal path prefix is removed from the public `Config.parse` signature.
