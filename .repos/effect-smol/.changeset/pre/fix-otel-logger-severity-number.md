---
"@effect/opentelemetry": patch
---

Logger: emit OTel-spec `SeverityNumber` (1-24) instead of Effect's internal log-level ordinal.

`OtelLogger.make` previously passed `LogLevel.getOrdinal(level)` (e.g. Info=20000, Error=40000) as `severityNumber`, which falls outside the OpenTelemetry logs data model spec range (1-24). Backends that validate the field (Honeycomb, Datadog, etc.) bucket such values as `UNSPECIFIED`.

The mapping now follows the spec:

| Effect LogLevel | OTel SeverityNumber |
| --------------- | ------------------- |
| Trace           | TRACE (1)           |
| Debug           | DEBUG (5)           |
| Info            | INFO (9)            |
| Warn            | WARN (13)           |
| Error           | ERROR (17)          |
| Fatal           | FATAL (21)          |

Also exports the helper `logLevelToSeverityNumber` for downstream use.
