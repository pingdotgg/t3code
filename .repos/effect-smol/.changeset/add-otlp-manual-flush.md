---
"effect": patch
---

Add manual flushing to the OTLP exporters through a shared `Flusher` service exposed by each signal layer. The signal layer output types now include `Flusher`, and `OtlpExporter.make` requires it so custom exporters register unconditionally.
