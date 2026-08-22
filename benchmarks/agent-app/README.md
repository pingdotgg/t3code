# Agent-app performance benchmark v1

This directory defines a reproducible, app-neutral benchmark for local desktop coding-agent
applications. It compares individual metrics only after the application proves that it rendered the
same work correctly. It does not define a composite score, rank unsupported profiles, measure model
or network latency, or claim that a new app process has cold operating-system caches.

Generated corpora and results belong under `artifacts/agent-app-benchmark/`, which is gitignored.
The only committed corpus file is the public generator configuration and its expected manifest at
`corpora/core-v1.json`.

## Portable JSON Schemas

An implementation in any language can validate the wire and artifact shapes with the committed
JSON Schema Draft 2020-12 documents. Each schema has a stable v1 URN and rejects unknown object
properties:

| Boundary                   | Schema                                                                   | Complete example                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Materialized corpus        | [`corpus-v1.schema.json`](schemas/corpus-v1.schema.json)                 | [`corpus-v1.json`](examples/corpus-v1.json)                                                                            |
| Driver request or response | [`driver-message-v1.schema.json`](schemas/driver-message-v1.schema.json) | [`hello-request-v1.json`](examples/hello-request-v1.json), [`hello-response-v1.json`](examples/hello-response-v1.json) |
| Raw metric sample          | [`raw-sample-v1.schema.json`](schemas/raw-sample-v1.schema.json)         | [`raw-sample-v1.json`](examples/raw-sample-v1.json)                                                                    |
| Environment disclosure     | [`environment-v1.schema.json`](schemas/environment-v1.schema.json)       | [`environment-v1.json`](examples/environment-v1.json)                                                                  |
| Result bundle              | [`result-bundle-v1.schema.json`](schemas/result-bundle-v1.schema.json)   | [`result-bundle-v1.json`](examples/result-bundle-v1.json)                                                              |

The files are generated from the authoritative Effect Schemas and checked for byte-independent JSON
equality in contract tests. Regenerate them from the repository root after an intentional contract
change:

```sh
node scripts/lib/agent-app-benchmark/json-schema.ts benchmarks/agent-app/schemas
vp fmt benchmarks/agent-app/schemas
```

JSON Schema validates the portable structural contract. The documented cross-field rules—metric
unit matching, monotonic clock evidence, valid/invalid consistency, correlation uniqueness, and
request/response pairing—still apply because JSON Schema cannot express all of them directly.

## Generate the public corpus

From the repository root, with the supported Node version and workspace dependencies installed:

```sh
node scripts/lib/agent-app-benchmark/corpus.ts \
  benchmarks/agent-app/corpora/core-v1.json \
  artifacts/agent-app-benchmark/corpora/core-v1.corpus.json
```

Generation fails if the resulting counts or SHA-256 digests differ from the committed manifest. The
artifact contains deterministic synthetic text, Markdown, code, tables, diffs, tool lifecycle
revisions, reasoning, attachment metadata, and ANSI terminal bytes. It contains no copied user
transcript or attachment body.

The optional OpenCode importer is local-only. It opens the source SQLite database read-only, creates
a consistent `VACUUM INTO` snapshot in an owner-readable private directory, and ranks sessions by
the bytes in their final `message` and `part` rows. It keeps the largest 20 with their ordered related
events. Never use a live database as an application profile, commit a local corpus, or treat a
privacy-scanner pass as permission to publish raw corpora, logs, traces, screenshots, or errors.

## Capability profiles

Drivers declare only profiles the stock application implements and can validate:

- `workspace-core-v1`: launch, open a work item, and switch among 20 work items.
- `resource-core-v1`: attributable whole-process-family observation and quiescence.

`N/A — unsupported capability` is valid. A timing for a profile whose corpus coverage failed is not.

## Primary metrics

The primary set is closed for framework version 1. Diagnostics use separate names and never become
comparison inputs implicitly.

| ID  | JSON metric                            | Unit      | Required endpoint                                                           |
| --- | -------------------------------------- | --------- | --------------------------------------------------------------------------- |
| M1  | `app.cold_ready_ms`                    | `ms`      | Pre-spawn driver mark to a stable, input-accepting primary surface.         |
| M2  | `work_item.cold_open_ms`               | `ms`      | Trusted activation to the requested painted anchor and usable input.        |
| M3  | `work_item.warm_switch_p95_ms`         | `ms`      | Within-run p95 over seeded switches among 20 work items.                    |
| M4  | `history.navigate_p95_ms`              | `ms`      | Within-run p95 over stable first/middle/last anchor navigation.             |
| M5  | `resource.peak_process_family_rss_mib` | `MiB`     | Maximum sampled sum across the disclosed app-owned process family.          |
| M6  | `resource.quiescent_cpu_p95_pct`       | `percent` | Process-family CPU p95 after 15 seconds quiescence over a 60-second window. |

Every measured duration includes raw endpoints from one named monotonic clock owner/domain,
resolution, observer method, semantic milestone sequence, and validity evidence. Timestamps from
different processes are never subtracted. Unsupported, invalid, bounded, and exact observations are
distinct JSON states.

## Executable driver protocol

A driver is an executable that reads one JSON object per line from stdin and writes exactly one JSON
object per line to stdout. Logs go to stderr and must not contain corpus content. UTF-8 and `\n`
delimiters are required. Every object has `protocolVersion: 1`, a `kind`, a non-empty
`correlationId`, and one of these methods:

1. `hello`: negotiate version and return immutable app/driver identities, supported profiles,
   scenarios and metrics, readiness/paint detection methods, and required preparation.
2. `prepare`: receive corpus path/digest, isolated run directory, and requested profiles; return
   coverage counts and semantic hashes.
3. `launch`: receive an isolated application-profile path; return app- and harness-owned PID/start
   identities, classification, automation readiness, and evidence.
4. `run-scenario`: receive attempt/profile/scenario/seed; return one or more raw metric samples.
5. `shutdown`: receive a reason; terminate only owned child handles and return terminated processes
   plus any survivors.

Request example:

```json
{
  "protocolVersion": 1,
  "kind": "request",
  "correlationId": "hello-1",
  "method": "hello",
  "params": { "frameworkVersion": 1 }
}
```

Copyable source: [`hello-request-v1.json`](examples/hello-request-v1.json).

Capability-limited success example:

```json
{
  "protocolVersion": 1,
  "kind": "response",
  "correlationId": "hello-1",
  "method": "hello",
  "ok": true,
  "result": {
    "protocolVersion": 1,
    "application": { "name": "Example Terminal", "version": "1.2.3", "build": "release" },
    "driver": {
      "name": "example-driver",
      "version": "1.0.0",
      "digestSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "capabilities": {
      "profiles": ["workspace-core-v1", "resource-core-v1"],
      "scenarios": [
        "work-item-cold-open-v1",
        "work-item-warm-switch-v1",
        "resource-sweep-v1",
        "resource-quiescence-v1"
      ],
      "metrics": [
        "work_item.cold_open_ms",
        "work_item.warm_switch_p95_ms",
        "resource.peak_process_family_rss_mib",
        "resource.quiescent_cpu_p95_pct"
      ],
      "readinessDetection": "trusted terminal focus and input",
      "paintDetection": "model sequence followed by renderer paint",
      "requiredPreparation": ["isolated profile"]
    }
  }
}
```

Copyable source: [`hello-response-v1.json`](examples/hello-response-v1.json). Supporting only the
workspace and resource profiles is valid; the driver must not fabricate coverage or samples.

Bounded error example (messages are limited to 1,024 characters):

```json
{
  "protocolVersion": 1,
  "kind": "response",
  "correlationId": "launch-1",
  "method": "launch",
  "ok": false,
  "error": {
    "code": "app-crashed",
    "message": "The application exited before automation readiness.",
    "retriable": false
  }
}
```

### Complete raw sample

This exact observation uses one renderer monotonic clock. `sequence` orders semantic milestones;
timestamps are endpoints on the named `clockOwner` and `clockDomain`, not wall-clock time. An exact
or bounded observation must use the unit assigned to its primary metric.

```json
{
  "schemaVersion": 1,
  "sampleId": "sample-1",
  "attemptId": "attempt-1",
  "profile": "workspace-core-v1",
  "scenario": "work-item-cold-open-v1",
  "metric": "work_item.cold_open_ms",
  "observation": {
    "state": "exact",
    "value": 12.5,
    "unit": "ms"
  },
  "evidence": [
    {
      "sequence": 0,
      "name": "trusted-action-to-stable-semantic-paint",
      "clockOwner": "renderer",
      "clockDomain": "performance",
      "resolutionMs": 0.1,
      "observerMethod": "Trusted click followed by two identical animation-frame snapshots.",
      "startTimestamp": 10,
      "endTimestamp": 22.5
    }
  ],
  "validity": {
    "status": "valid",
    "evidence": [
      {
        "check": "canonical-latest-turn-stable-and-visible",
        "expectedSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "actualSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "passed": true
      }
    ]
  }
}
```

Copyable source: [`raw-sample-v1.json`](examples/raw-sample-v1.json).

### Complete result bundle

A result carries immutable identities, the corpus digest, exact environment, included/excluded
process topology, every attempt in execution order, raw samples, statistics, and limitations. This
minimal valid bundle contains one measured smoke attempt. Publication bundles use the same shape but
must follow the larger run counts and validity rules below.

```json
{
  "schemaVersion": 1,
  "frameworkVersion": "1.0.0",
  "runId": "portable-example-run-1",
  "corpus": {
    "corpusId": "portable-example-v1",
    "digestSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "runProfile": "smoke",
  "application": {
    "name": "Example Terminal",
    "version": "1.2.3",
    "build": "release"
  },
  "driver": {
    "name": "example-driver",
    "version": "1.0.0",
    "digestSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "profiles": ["workspace-core-v1"],
  "environment": {
    "capturedAt": "2026-08-09T00:00:00.000Z",
    "os": "macOS 26",
    "architecture": "arm64",
    "cpuModel": "Apple M4",
    "logicalCoreCount": 10,
    "physicalMemoryBytes": 16000000000,
    "displayRefreshHz": 60,
    "displayScale": 2,
    "powerSource": "ac",
    "thermalState": "nominal",
    "window": { "width": 1440, "height": 900 },
    "colorScheme": "dark",
    "reducedMotion": true,
    "launchFlags": []
  },
  "resourceTopology": {
    "included": [
      {
        "pid": 4100,
        "startTimeMs": 1723161600000,
        "owner": "application",
        "category": "desktop-main"
      }
    ],
    "excluded": [
      {
        "pid": 4200,
        "startTimeMs": 1723161600000,
        "owner": "harness",
        "category": "resource-observer"
      }
    ],
    "unattributed": []
  },
  "attempts": [
    {
      "attemptId": "attempt-1",
      "measured": true,
      "samples": [
        {
          "schemaVersion": 1,
          "sampleId": "sample-1",
          "attemptId": "attempt-1",
          "profile": "workspace-core-v1",
          "scenario": "work-item-cold-open-v1",
          "metric": "work_item.cold_open_ms",
          "observation": { "state": "exact", "value": 12.5, "unit": "ms" },
          "evidence": [
            {
              "sequence": 0,
              "name": "trusted-action-to-stable-semantic-paint",
              "clockOwner": "renderer",
              "clockDomain": "performance",
              "resolutionMs": 0.1,
              "observerMethod": "Trusted click followed by two identical animation-frame snapshots.",
              "startTimestamp": 10,
              "endTimestamp": 22.5
            }
          ],
          "validity": {
            "status": "valid",
            "evidence": [
              {
                "check": "canonical-latest-turn-stable-and-visible",
                "expectedSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "actualSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "passed": true
              }
            ]
          }
        }
      ],
      "diagnostics": []
    }
  ],
  "statistics": [
    {
      "profile": "workspace-core-v1",
      "metric": "work_item.cold_open_ms",
      "unit": "ms",
      "median": 12.5,
      "confidenceInterval95": { "lower": 11.8, "upper": 13.2 },
      "measuredCount": 1,
      "invalidCount": 0
    }
  ],
  "limitations": ["Smoke results are estimates and are not publication evidence."]
}
```

Copyable source: [`result-bundle-v1.json`](examples/result-bundle-v1.json). The standalone
environment object is also available as [`environment-v1.json`](examples/environment-v1.json).

Correlation IDs are unique per request; a response must repeat the request ID and method. Duplicate
requests/responses, unsolicited responses, unknown versions or primary metrics, negative values,
wrong metric units, missing validity evidence, reversed endpoints, and non-monotonic evidence are
protocol failures. A timeout bounds a failed operation; it is never readiness evidence.

Drivers are trusted local executables, not sandboxes. An unknown driver has the user's filesystem
privileges. Publication runs use reviewed source pinned to an immutable commit/digest, a disposable
working directory and app profile, the sanitized public corpus, and no ambient benchmark secrets.

## Publication rules

- Smoke is one warm-up plus three measured runs; quick is one plus five. Both are estimates.
- Publication is three warm-ups plus twenty measured runs per app/profile, with seeded interleaving.
- Use release or production-equivalent builds and fresh isolated app profiles. Do not flush OS caches.
- Preserve samples in execution order and delete no statistical outliers.
- Publish absolute values, median and 95% bootstrap intervals, invalid/failed counts, corpus and
  scenario digests, measurement methods, process topology, environment, versions, and limitations.
- A publication attempt with any invalid measured run is not rankable. A new attempt does not erase
  the failed one or selectively replace samples.
- Compare only shared, coverage-valid profiles; never turn missing work into a performance advantage.
- Resource sampling requests 250 ms during active work and 1,000 ms during quiescence. Missing or
  unexplained samples invalidate resource metrics under the framework rules.

The authoritative machine-readable schemas and cross-field validators are in
`scripts/lib/agent-app-benchmark/contracts.ts`. This README intentionally provides enough JSON
vocabulary for a driver in another language to implement the protocol without importing T3 code.
