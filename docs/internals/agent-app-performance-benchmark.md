# Public agent-app performance benchmark

T3 Code implements an app-owned driver for the public
[Agent App Benchmark](https://github.com/kyashrathore/agent-app-benchmark). The benchmark framework,
schemas, OpenCode event corpus, resource monitor, result corpus, and comparison website live in that
repository. T3 owns only the translation into its production projection schema and the UI automation
needed to declare its native readiness endpoint.

V1 measures completed historical GUI sessions. It does not run an agent, stream output, exercise a
terminal, or measure Web Vitals. The shared suite defines exact app-start states, four independent
session-switch lanes, 1–32 MiB transcript sizes, external process-family CPU/RSS sampling, and public
result derivation.

## T3 adapter flow

1. `t3-public-materializer.ts` reads the pinned OpenCode NDJSON stream in sequence, verifies each file
   digest and transcript byte count, translates it into `ProjectionFixture`, writes through
   `writeProjectionFixture()`, and reads the database back before returning a mapping receipt.
2. `t3.ts` seals `P0` after materialization. T3 has never launched that state.
3. It clones `P0`, performs one unmeasured launch to the common control-session endpoint, shuts down
   cleanly, and seals the result as `P1`.
4. Every measured attempt clones the requested sealed state. The driver returns only application root
   process identities; the shared runner observes the complete process family.
5. Session-switch timing begins at a trusted row click in the renderer and ends after the canonical
   final message is visible with non-empty text, the first fold is complete, the composer is usable,
   and two consecutive animation-frame snapshots are stable.

For a cold switch, the driver first returns to the control session and then measures the destination's
first activation in that app process. For a warm switch, it performs one unmeasured destination
activation, returns to control, and measures the destination revisit. The driver reports one raw
duration; averages, maximums, p95, CPU, memory, trends, and the website are framework-owned.

## Running

Build the production desktop bundle first. Then clone the public framework, generate its corpus and
resource-monitor binary, and use this repository's driver:

```bash
node /absolute/path/to/agent-app-benchmark/bin/agent-app-benchmark.mjs run \
  --driver /absolute/path/to/t3code/scripts/lib/agent-app-benchmark/drivers/t3.ts \
  --app t3 \
  --scenario session-switch-v1 \
  --run-profile smoke \
  --resource-monitor /absolute/path/to/agent-app-resource-monitor \
  --output /absolute/path/to/run-output
```

The driver creates disposable state only below the framework-provided run directory and never reads
or writes the user's live `T3CODE_HOME`. Publish results by opening a pull request against the public
benchmark repository.
