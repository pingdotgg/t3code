---
"effect": patch
"@effect/opentelemetry": patch
---

Align runtime type IDs with their module paths. Effect markers now omit legacy grouping prefixes and the `unstable` path segment, while OpenTelemetry spans use the `OtelTracer` module path. Custom implementations that copy these marker strings must adopt the corrected IDs.
