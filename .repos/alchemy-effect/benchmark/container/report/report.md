# Cold-start benchmark

Run `2026-07-02T01-28-09-381Z` — 700 samples. Metric: **time to usable service** (host start → first successful request).

Methodology: targets run sequentially so they never contend for shared quotas. Containers are measured under concurrent load (10 rounds × 10 simultaneous boots). MicroVMs are measured **independently** — 25 serial boots at concurrency 1 — because the Lambda MicroVM API is throttled per account/Region (RunMicrovm 5 TPS/burst 5, TerminateMicrovm 10 TPS), so concurrent boots would measure API admission rather than VM cold start. Each boot launches, waits until the service is usable, then terminates before the next; the image is pre-warmed once (untimed) so we measure cold start, not first-pull distribution.

| environment | variant | ok | ready p50 | ready p95 | ready mean | ready max | first → last round (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| container | effectful | 100/100 | 2.3s | 24.0s | 4.7s | 46.7s | 15.3s → 2.1s |
| container | bun | 100/100 | 1.7s | 23.9s | 3.9s | 47.3s | 17.4s → 1.7s |
| container | remote | 100/100 | 2.6s | 24.4s | 4.5s | 26.1s | 11.5s → 2.4s |
| container | opencode | 100/100 | 10.5s | 15.6s | 12.0s | 58.6s | 25.4s → 10.6s |
| lambda→microvm | effectful-bun | 25/25 | 2.9s | 4.4s | 2.8s | 4.8s | 4.8s → 2.0s |
| lambda→microvm | effectful-node | 25/25 | 3.2s | 3.7s | 3.6s | 16.6s | 3.4s → 2.5s |
| lambda→microvm | bun | 25/25 | 2.7s | 3.2s | 2.7s | 3.7s | 3.2s → 2.3s |
| lambda→microvm | node | 25/25 | 3.3s | 3.8s | 3.2s | 4.2s | 3.5s → 3.3s |
| lambda→microvm | external | 25/25 | 2.2s | 2.8s | 2.2s | 2.8s | 2.4s → 2.2s |
| lambda→microvm | opencode | 25/25 | 3.4s | 4.1s | 3.4s | 4.5s | 3.8s → 4.1s |
| worker→microvm | effectful-bun | 25/25 | 2.7s | 3.7s | 2.8s | 4.1s | 3.7s → 3.2s |
| worker→microvm | effectful-node | 25/25 | 3.6s | 9.4s | 4.0s | 9.6s | 6.0s → 2.8s |
| worker→microvm | bun | 25/25 | 3.1s | 3.8s | 2.9s | 5.4s | 3.8s → 3.2s |
| worker→microvm | node | 25/25 | 3.2s | 4.3s | 3.4s | 6.9s | 3.2s → 3.0s |
| worker→microvm | external | 25/25 | 2.4s | 2.9s | 2.3s | 3.0s | 3.0s → 2.9s |
| worker→microvm | opencode | 24/25 | 3.6s | 4.0s | 3.5s | 4.2s | 1.9s → 3.1s |

Raw per-boot samples: `data/samples-2026-07-02T01-28-09-381Z.csv`. Aggregates: `report/summary.csv`.
