# Relay observability

The relay Alchemy stack (`infra/relay`) provisions stage-scoped Axiom datasets (`t3-code-relay-traces-<stage>`, `t3-code-mobile-logs-<stage>`, `t3-code-mobile-metrics-<stage>`), scoped write-only ingest tokens, the `t3-code-mobile-sourcemaps-<stage>` R2 bucket, and health dashboards (`t3-code-relay-health`, `t3-code-mobile-health`).

Prefer Axiom dashboards and APL queries over tailing the Cloudflare Worker. Scripted queries use account-level `AXIOM_TOKEN` + `AXIOM_ORG_ID` (runtime ingest tokens are write-only). Effect HTTP attributes live under `attributes.http.*`, and relay custom annotations live under `attributes.custom`.

## Alerts

Threshold monitors in [`infra/relay/src/monitoring.ts`](../../infra/relay/src/monitoring.ts) activate when `RELAY_ALERT_NOTIFIER_ID` is set (optional warnings go to `RELAY_WARNING_NOTIFIER_ID`). Monitors count HTTP status codes, not span errors—a 9 s relay timeout returns 504 even without a span error flag, and `/connect` 502s are normal for offline hosts.

- **Links / tunnel recovery failing / Cloudflare 429s:** Check "Link failures by reason" and Cloudflare API status on `t3-code-relay-health`. Sustained 429s indicate Cloudflare API rate limiting or a recovery loop; slow Postgres points at DB/Hyperdrive.
- **Environments unreachable:** Check Cloudflare Tunnel status and recent relay deploys before blaming hosts.
- **Push delivery failing:** Inspect `relay.apns_deliveries.process_signed_job` or `relay.fcm.process` errors—an expired APNs key or FCM service account fails every job.
- **Traffic dropped:** Check `https://relay.t3.codes/health` first.
- **Tunnel cleanup stopped / deletions failing:** Check `relay.managed_endpoint_reaper.sweep` spans and Cloudflare API errors. To pause cleanup during an incident, set `RELAY_TUNNEL_CLEANUP_MODE=off` and redeploy the relay (see [Managed tunnel cleanup rollout](./03_release.md#managed-tunnel-cleanup-rollout)).

## Mobile crashes and errors

The mobile app sends `expo-observe` telemetry to the relay (`/v1/mobile/observe`), which forwards logs, metrics, and spans to Axiom and symbolicates release Hermes JS stacks using source maps from R2 (`relay.symbolication.status` records the outcome).

- **Counting real native crashes:** Fatal JS errors also trigger a native abort; filter out `relay.crash.js_fatal` (and Android OS `SIGKILL`s, which indicate memory pressure/swiping) when counting native crashes:

  ```apl
  ['t3-code-mobile-logs-prod']
  | where ['attributes.expo.error.source'] == 'nativeCrash'
  | where isnull(['attributes.relay.crash.js_fatal'])
  | summarize count() by ['attributes.exception.type'], ['attributes.exception.message']
  ```

- **Symbolicating iOS native crashes:** Download the build's dSYM archive from R2 at `ios/dsym/<easBuildId>.zip` and resolve offsets (`T3Code + <offset>`):

  ```sh
  unzip <easBuildId>.zip
  atos -arch arm64 -o T3Code.app.dSYM/Contents/Resources/DWARF/T3Code -l 0x100000000 \
    $(printf '0x%x' $((0x100000000 + <offset>)))
  ```

- **Source map upload secret:** `MOBILE_SOURCEMAPS_R2` comes from Alchemy output `mobileSourceMapsUploadCredentials` (`cd infra/relay && vp exec alchemy state read T3CodeRelay/prod/output`). Store it as a GitHub Actions secret (for OTA updates) and as an EAS `production`-only secret (never `preview`, which runs PR code).
- **Mobile alerts ([`infra/relay/src/mobileTelemetry/monitoring.ts`](../../infra/relay/src/mobileTelemetry/monitoring.ts)):** Crash spikes right after a release usually indicate a bad OTA—roll back in EAS. Android OS-kill spikes lag releases and point to memory leaks or main-thread freezes.
