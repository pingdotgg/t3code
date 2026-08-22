# Agent-app performance benchmark

> For maintainers. This is a contributor/release tool, not a CI performance gate.

Status: implemented framework; results are generated artifacts, never a permanently current baseline.

## Purpose

The agent-app benchmark measures local desktop workflows with a generated public corpus, an external executable driver protocol, semantic correctness gates, renderer observations, whole-process resource sampling, and auditable statistics. T3 Code ships the reference driver. Another application can participate by implementing the versioned NDJSON protocol documented in [`benchmarks/agent-app/README.md`](../../benchmarks/agent-app/README.md).

There is deliberately no aggregate performance score. A result is comparable only for a capability profile that both applications declare and validate, and each metric stands on its own.

## Run it

Install the repository dependencies and build the production-equivalent desktop app and native resource monitor. Then run a smoke attempt:

```sh
pnpm benchmark:agent-app --run-profile smoke
```

The defaults use the generated public `core-v1` corpus, the T3 reference driver, `workspace-core-v1`, seed `1`, and the quick run profile. Useful options are:

```sh
pnpm benchmark:agent-app \
  --app-driver /absolute/path/to/driver \
  --corpus benchmarks/agent-app/corpora/core-v1.json \
  --profiles workspace-core-v1,resource-core-v1 \
  --run-profile publication \
  --seed 1729 \
  --environment /absolute/path/to/environment.json \
  --shareable-report \
  --output artifacts/agent-app-benchmark
```

TypeScript and JavaScript driver paths are launched with the current Node executable. Other paths are launched directly without a shell. Drivers are trusted local executables with the user's filesystem privileges; review and pin their source before running them.

## Profiles and metrics

The framework versions two capability profiles:

- `workspace-core-v1`: launch, cold open, and seeded switches among work items;
- `resource-core-v1`: sampled process-family RSS and quiescent CPU.

The primary metrics and units are closed in framework version 1. Renderer heap, DOM nodes, I/O, process counts, wakeups, and traces are diagnostics. They cannot silently become primary comparison inputs.

Correctness precedes speed. Coverage hashes, visible targets, input acceptance, crash/reload state, clock provenance, process ownership, and monitor health are validity evidence. An invalid measured sample remains in `samples.ndjson` and makes that publication attempt unrankable.

Cold-open and warm-switch timing does not stop at a title, composer, route, loading surface, skeleton, or shimmer. Corpus preparation records the canonical visible message IDs from every session's latest turn. After the trusted activation, the driver requires one of those exact messages to be non-empty and visible, the first fold to contain no blank virtualization gap, and the same semantic/geometry snapshot to survive two consecutive animation frames. The second stable frame is the end timestamp. Warm-switch runs first open all 20 items through the same public UI path without recording those opens, then measure one seeded switch to each item; the first measured target cannot equal the final warm-up target.

## Run profiles

| Run profile | Warm-ups | Measured runs | Use                                          |
| ----------- | -------: | ------------: | -------------------------------------------- |
| Smoke       |        1 |             3 | Harness validation; non-publishable estimate |
| Quick       |        1 |             5 | Local iteration; estimate                    |
| Publication |        3 |            20 | Reviewable same-machine evidence             |

Publication comparisons randomize and interleave app/scenario order from the recorded seed. Raw samples stay in execution order. The runner never deletes outliers or selectively replaces failed samples.
Publication runs require an explicit `--environment` file with non-unknown thermal and power state; the CLI will not substitute guessed host values. Without that file, a Node process cannot observe display refresh, display scale, window size, colour scheme, or reduced-motion state, so the CLI declares placeholders, warns on stderr, and records a limitation naming those fields; they are never presented as measured host facts.

Each metric reports the median and a seeded 95% bootstrap interval across measured runs. Interaction scenarios may additionally report a within-run p95. Pairwise direction comes only from the paired per-run difference interval; separately overlapping or non-overlapping app intervals do not establish direction. If the paired interval includes zero, the report says there is no clear difference. If an effect does not exceed the disclosed clock/observer resolution, it is not ranked.

Event Timing measurements below the browser threshold remain bounded (for example, `<16 ms`) rather than becoming zero. An unavailable Long Animation Frame API makes only M6 unsupported.

## Artifact layout

Every attempt receives an owner-readable directory below `artifacts/agent-app-benchmark/`:

```text
attempt-…/
  run-N/             fresh isolated profile and application lifecycle (M9/M10 share one)
  run.json           identities, schedule, status, topology, digests
  result.json        canonical versioned result bundle and statistics
  samples.ndjson     append-only raw samples in execution order
  resources.ndjson   external process-family observer rows, when requested
  coverage.json      profile coverage evidence
  environment.json   host and display disclosure
  report.md          independent metric summaries and limitations
```

Failed attempts are retained as typed incomplete artifacts. Cleanup records exact owned process identities. Recover by inspecting `run.json` and terminating only a surviving PID whose start time still matches; never kill by command-name or path pattern.

## Corpus handling and privacy

The committed `core-v1.json` is a generator configuration and expected semantic manifest, not a transcript database. Generation is deterministic and the CLI refuses a digest mismatch.

The optional OpenCode importer opens the source read-only, creates a consistent `VACUUM INTO` snapshot, and ranks sessions by final renderable message/part bytes. Imported data, snapshots, traces, screenshots, logs, and raw failures are private even if a scanner finds no known secret. Shareable output is constructed from a closed aggregate allowlist and then scanned as defense in depth.

`--shareable-report` validates only the aggregate report. It does not make the surrounding corpus, raw samples, resource rows, logs, traces, screenshots, or failed-run payloads safe to publish.

Never use `~/.t3/userdata` or a live OpenCode database as the application home. Data moves only into a disposable benchmark directory.

## Resource semantics

Active scenarios request 250 ms samples; quiescent CPU requests 1,000 ms samples after the framework's idle window. M9 is a sampled peak, not an instantaneous maximum. M9 and M10 are invalid when sample coverage falls below 95%, unexplained gaps exceed twice the cadence, the observer is degraded, or an app helper cannot be attributed.

The external observer is harness-owned and excluded. T3's server, renderer, GPU/utility, terminal/provider descendants, and shipped internal monitor are app-owned and included. PID identity is `(pid, startTimeMs)`. Observer overhead is disclosed and never subtracted from the app total. Platform I/O semantics follow [resource telemetry](./resource-telemetry.md).

## Publication and cross-app evidence

Run applications on the same machine, OS session, display, scale, power state, corpus, seed, and profile sequence. Use stock release-equivalent builds and isolated homes. Record immutable application and driver commits plus executable digests. Only profiles with passing protocol, lifecycle, privacy, coverage, and process-ownership conformance enter paired tables.

Attach `run.json`, `result.json`, `samples.ndjson`, `coverage.json`, `environment.json`, and `report.md` to the review or release. Do not commit a machine-specific “current baseline.” Keep local-session results separate, label them non-reproducible, and disclose aggregate workload properties only.

Forbidden claims include an overall winner, cross-OS aggregation, a renderer-heap-as-total-memory claim, a timing for failed coverage, and significance inferred from separate confidence intervals.

## Diagnostic reruns

`--diagnostic` adds a separately labeled rerun after primary measurement. Heavy tracing, screenshots, video, DevTools UI, and resource bodies must remain out of primary measurements. Diagnostic artifacts may contain source and credentials and are private by default.

## Versioning

Changing a metric boundary, sampling cadence, corpus semantics, driver lifecycle, validity rule, or report comparison rule requires a framework/corpus/protocol version change. Older results retain their original meaning and are not silently recomputed under the new contract.
