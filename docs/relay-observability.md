# Relay observability

The relay Alchemy stack owns a focused Axiom trace setup:

- `t3-code-relay-traces-prod`, an OpenTelemetry trace dataset for Worker requests
- `t3-code-relay-otel-ingest-prod`, a dataset-scoped ingest token bound to the Worker
- `t3-code-relay-recent-spans-prod`, a view of recent request and endpoint spans

Alchemy stages append their sanitized stage name to isolate resources, for example
`t3-code-relay-traces-dev-julius` for a personal stage.

Deploy from `infra/relay` with the normal Alchemy workflow:

```sh
vp run deploy
```

Alchemy resolves Axiom deployment credentials through its provider. At runtime, the Worker
receives only the scoped ingest token; it does not receive the diagnostics query token.

The Worker emits Effect's built-in HTTP server spans plus endpoint and database child spans.
Effect's OpenTelemetry exporter stores semantic HTTP attributes below the `attributes.` prefix.
For example:

```apl
['t3-code-relay-traces-prod']
| where name startswith 'http.server'
| project _time, name, trace_id, duration,
    ['attributes.http.request.method'],
    ['attributes.url.path'],
    ['attributes.http.response.status_code']
| order by _time desc
| limit 200
```

Endpoint failure annotations and other relay-specific attributes are also emitted in the
`attributes.custom` map when present on a span, for example
`['attributes.custom']['relay.endpoint']`.

Agents should prefer the provisioned view or APL queries for completed incidents instead of
tailing the Cloudflare Worker. Use the read-only query token when scripted access is needed;
keep the ingest token reserved for the Worker.
