# Relay observability

The relay Alchemy stack owns Axiom resources for post-hoc diagnostics:

- `t3-code-relay-events` for Effect logs and spans
- `t3-code-relay-metrics` for Effect metrics
- `t3-code-relay-otel-ingest` for Worker OTLP ingest
- `t3-code-relay-readonly-query` for human/agent log lookup
- `T3 Code Relay Operations` dashboard
- starter views for recent logs and recent failures
- monitors for warning/error logs, APNS failures, managed tunnel provisioning failures, and quiet log ingestion

Deploy from `infra/relay` with the normal Alchemy workflow:

```sh
bun run deploy
```

Alchemy resolves Axiom credentials through the Axiom provider. Use either environment credentials or `alchemy login --configure` before deploy.

Useful APL queries:

```apl
['t3-code-relay-events']
| order by _time desc
| limit 200
```

```apl
['t3-code-relay-events']
| extend logSeverity = column_ifexists('severityText', '')
| extend logBody = column_ifexists('body', '')
| where logSeverity in ("WARN", "WARNING", "ERROR", "FATAL")
  or logBody contains "failed"
  or logBody contains "error"
| order by _time desc
| limit 200
```

Metrics intentionally capture product and state signals that are not just trace counts:

- `relay_managed_tunnel_provisions_total`: managed tunnel provisioning outcomes, split by `created` versus `reused`
- `relay_environment_links_total`: link and unlink lifecycle operations
- `relay_managed_tunnels_active`: current active managed-tunnel links
- `relay_environment_links_active`: current active environment links
- `relay_mobile_devices_registered`: current registered mobile devices
- `relay_live_activity_targets_active`: current active Live Activity targets
- `relay_agent_activities_active`: current active agent activity rows
- `relay_agent_activity_publishes_total`: agent activity publish/replay lifecycle events
- `relay_apns_deliveries_total`: APNS enqueue/send outcomes for Live Activities and push notifications

The `*_active` and `*_registered` values are gauges refreshed from the relay database, which is the source of truth for current state. Lifecycle counters are updated from the mutation path after successful writes or delivery outcomes.

Useful metrics queries:

```mpl
`t3-code-relay-metrics`:`relay_managed_tunnels_active`
| group using sum
```

```mpl
`t3-code-relay-metrics`:`relay_managed_tunnel_provisions_total`
| map increase
| align to 5m using sum
| group by outcome, tunnelProvisionKind using sum
```

Agents should prefer Axiom views or APL queries for completed incidents instead of tailing the Cloudflare Worker. Use the read-only query token when scripted access is needed; keep the ingest token reserved for the Worker.
