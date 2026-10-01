---
name: debuggability-auditability
description: Makes software behavior easier to investigate and important actions easier to verify, using structured logs, traces, durable records, and practical CLI queries. Use when adding observability or audit trails, or when asked how to inspect T3 runtime activity and evidence.
---

# Debuggability and Auditability

Make the evidence answer a concrete question. Prefer existing T3 observability over new logging; read [the observability guide](../../../docs/observability.md) for details.

## Inspect T3 evidence

```sh
# Recent thread activity, including shell execution summaries
t3 chat show <thread-id> --activities --limit 50

# Turn history and code-change provenance
t3 chat show <thread-id> --messages --limit 20
t3 diff turn <thread-id> <turn-count>
t3 checkpoint list <thread-id>
```

Server logs and completed spans are local NDJSON. In a default install:

```sh
LOGS="${T3CODE_HOME:-$HOME/.t3}/userdata/logs"

# Failed spans and their correlation IDs
jq -c 'select(.exit._tag != "Success") |
  {name, traceId, durationMs, exit, attributes}' \
  "$LOGS/server.trace.ndjson"

# Errors for one thread in structured server logs
jq -c 'select(.level == "Error" and .annotations.threadId == "THREAD_ID") |
  {timestamp, message, annotations, cause}' \
  "$LOGS/server.log"
```

For monorepo dev, use `./dev/logs` instead. Follow a trace by filtering `traceId`; use
`server.log` for all log lines and `server.trace.ndjson` for span timing and embedded events.
Metrics are exported over OTLP when configured; they are not persisted locally.

## Add useful evidence

1. Put instrumentation at meaningful boundaries: RPCs, orchestration commands, provider calls,
   persistence, and external processes. Reuse existing spans and `withLogContext` correlation.
2. Record operation, outcome, duration, and relevant correlation IDs. Put high-cardinality details
   on spans/logs, not metric labels.
3. If a user action needs an audit trail, persist a durable domain record with actor, action,
   target, time, outcome, and correlation ID. Logs and traces are diagnostic evidence, not a
   substitute for a required product audit record.
4. Redact credentials, prompts, and sensitive command output. Report what evidence is missing;
   do not infer process liveness from an unfinished tool event.

Example query for slow spans:

```sh
jq -c 'select(.durationMs > 1000) |
  {name, traceId, durationMs, attributes}' \
  "$LOGS/server.trace.ndjson"
```

Inspect first and preserve correlation IDs when sharing a repro. A timed-out mutation may have
succeeded: check its recorded outcome before retrying. This skill does not authorize changes,
approvals, or external actions beyond the user's request.
