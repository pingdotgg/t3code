---
"effect": patch
---

Fix OTLP exporter shutdown to await in-flight and final buffered exports up to the configured shutdown timeout.
