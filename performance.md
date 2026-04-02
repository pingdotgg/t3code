# Performance

## Goal

Measure end-to-end server latency for control-plane commands through the real websocket/API surface, establish reproducible baselines under representative load, and track the effect of each optimization branch with before/after artifacts.

## Hypotheses

- `H1` Control-plane commands are waiting behind provider stream ingestion because `thread.create`, `thread.archive`, and chunk-derived commands all share the same serialized orchestration path.
- `H2` Projection work per streamed chunk is inflating queue occupancy enough to delay unrelated commands.
- `H3` Terminal output and git-heavy repositories add secondary pressure that can compound the control-plane delay seen in the sidebar.

## Workstreams

- `[completed]` Add server-first perf baselines for websocket command latency under stream, terminal, and git load.
- `[completed]` Establish baseline artifacts and summarize p50/p95 timings here.
- `[completed]` Reconcile the baseline with the manual sidebar lag repro before cutting optimization branches.
- `[completed]` Optimization 2: reduce per-event projection overhead.
- `[completed]` Optimization 3: prioritize control-plane dispatch over internal stream traffic.
- `[pending]` Optimization 4: reduce global worker head-of-line blocking in runtime ingestion/reactors.
- `[pending]` Optimization 5: evaluate adapter/service queue hops and any additional bottlenecks found during measurement.

## Artifact Log

| Branch                                           | Scope                                | Status    | Artifact                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `t3code/performance-regression-tests`            | Server perf harness + baseline specs | completed | [control-plane-stream-baseline.json](/Users/julius/.t3/worktrees/codething-mvp/t3code-93392e80/artifacts/perf/server/server-latency-critical-commands-burst_base-1775120110519/control-plane-stream-baseline.json) |
| `t3code/performance-regression-tests`            | Terminal + mixed git baseline        | completed | [terminal-mixed-git-baseline.json](/Users/julius/.t3/worktrees/codething-mvp/t3code-93392e80/artifacts/perf/server/server-latency-critical-commands-burst_base-1775120111902/terminal-mixed-git-baseline.json)     |
| `t3code/performance-regression-tests`            | Spam canary baseline                 | completed | [control-plane-stream-baseline.json](/Users/julius/.t3/worktrees/codething-mvp/t3code-93392e80/artifacts/perf/server/server-latency-critical-commands-burst_base-1775120442873/control-plane-stream-baseline.json) |
| `t3code/perf-checkpoint-reactor-fanout`          | Spam canary rerun                    | completed | [control-plane-stream-baseline.json](/Users/julius/.t3/worktrees/codething-mvp/t3code-93392e80/artifacts/perf/server/server-latency-critical-commands-burst_base-1775120608211/control-plane-stream-baseline.json) |
| `t3code/perf-checkpoint-reactor-fanout`          | Terminal + mixed git rerun           | completed | [terminal-mixed-git-baseline.json](/Users/julius/.t3/worktrees/codething-mvp/t3code-93392e80/artifacts/perf/server/server-latency-critical-commands-burst_base-1775120609839/terminal-mixed-git-baseline.json)     |
| `t3code/perf-projection-thread-message-hot-path` | Spam canary rerun                    | completed | [control-plane-stream-baseline.json](/Users/julius/.t3/worktrees/codething-mvp/t3code-93392e80/artifacts/perf/server/server-latency-critical-commands-burst_base-1775120998407/control-plane-stream-baseline.json) |
| `t3code/perf-projection-thread-message-hot-path` | Terminal + mixed git rerun           | completed | [terminal-mixed-git-baseline.json](/Users/julius/.t3/worktrees/codething-mvp/t3code-93392e80/artifacts/perf/server/server-latency-critical-commands-burst_base-1775121000048/terminal-mixed-git-baseline.json)     |
| `t3code/perf-control-plane-priority-lane`        | Spam canary rerun                    | completed | [control-plane-stream-baseline.json](/Users/julius/.t3/worktrees/codething-mvp/t3code-93392e80/artifacts/perf/server/server-latency-critical-commands-burst_base-1775121334761/control-plane-stream-baseline.json) |
| `t3code/perf-control-plane-priority-lane`        | Terminal + mixed git rerun           | completed | [terminal-mixed-git-baseline.json](/Users/julius/.t3/worktrees/codething-mvp/t3code-93392e80/artifacts/perf/server/server-latency-critical-commands-burst_base-1775121336380/terminal-mixed-git-baseline.json)     |

## Best So Far

- `create-turn-spam-8x` `thread.create dispatch -> thread.created`
  Baseline: `3.61ms / 58.38ms`
  Best so far: `2.38ms / 20.36ms` on `t3code/perf-projection-thread-message-hot-path`
  Tail improvement: `-65%` on p95
- `create-turn-spam-8x` `thread.archive dispatch -> thread.archived`
  Baseline: `5.71ms / 50.80ms`
  Best so far: `1.09ms / 12.60ms` on `t3code/perf-control-plane-priority-lane`
  Tail improvement: `-75%` on p95
- `mixed-stream-terminal-git` `thread.create dispatch -> thread.created`
  Baseline: `0.89ms / 1.57ms`
  Best so far: `1.16ms / 1.33ms` on `t3code/perf-control-plane-priority-lane`
  Tail improvement: `-15%` on p95
- `git.status`
  No clear improvement yet. The measurements move around, but there is no stable win I would claim from these changes.

## Detailed Results

| Branch                                           | Change         | Profile                     | Metric                                       | Before p50 / p95      | After p50 / p95       | Notes                                                                              |
| ------------------------------------------------ | -------------- | --------------------------- | -------------------------------------------- | --------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `t3code/performance-regression-tests`            | Baseline       | `idle`                      | `thread.create dispatch -> thread.created`   | `1.48ms / 14.95ms`    | `n/a`                 | one cold-start outlier remains, steady-state is low single-digit ms                |
| `t3code/performance-regression-tests`            | Baseline       | `idle`                      | `thread.archive dispatch -> thread.archived` | `1.64ms / 2.22ms`     | `n/a`                 | no material queueing at the WS boundary                                            |
| `t3code/performance-regression-tests`            | Baseline       | `assistant-stream-5x`       | `thread.create dispatch -> thread.created`   | `1.34ms / 1.85ms`     | `n/a`                 | 5 passive background streams still look healthy                                    |
| `t3code/performance-regression-tests`            | Baseline       | `assistant-stream-5x`       | `thread.archive dispatch -> thread.archived` | `1.03ms / 1.27ms`     | `n/a`                 | still effectively realtime                                                         |
| `t3code/performance-regression-tests`            | Baseline       | `create-turn-spam-8x`       | `thread.create dispatch -> thread.created`   | `3.61ms / 58.38ms`    | `n/a`                 | first server-first profile that reproduces visible event delay                     |
| `t3code/performance-regression-tests`            | Baseline       | `create-turn-spam-8x`       | `thread.archive dispatch -> thread.archived` | `5.71ms / 50.80ms`    | `n/a`                 | `dispatch -> ack` stays low; delay is mostly `ack -> event`                        |
| `t3code/performance-regression-tests`            | Baseline       | `terminal-output-3x`        | `thread.create dispatch -> thread.created`   | `1.55ms / 1.92ms`     | `n/a`                 | terminal output alone did not move command latency much                            |
| `t3code/performance-regression-tests`            | Baseline       | `mixed-stream-terminal-git` | `thread.create dispatch -> thread.created`   | `0.89ms / 1.57ms`     | `n/a`                 | combined load still fast at the command/event boundary                             |
| `t3code/performance-regression-tests`            | Baseline       | `idle-repo-pressure`        | `git.status`                                 | `135.30ms / 149.97ms` | `n/a`                 | 240 branches + 160 untracked files                                                 |
| `t3code/performance-regression-tests`            | Baseline       | `mixed-stream-terminal-git` | `git.status`                                 | `150.08ms / 169.73ms` | `n/a`                 | git RPC remains the largest measured server-side cost                              |
| `t3code/performance-regression-tests`            | Baseline       | `idle-repo-pressure`        | `git.listBranches`                           | `47.60ms / 54.00ms`   | `n/a`                 | branch enumeration cost is measurable but stable                                   |
| `t3code/perf-checkpoint-reactor-fanout`          | Optimization 1 | `create-turn-spam-8x`       | `thread.create dispatch -> thread.created`   | `3.61ms / 58.38ms`    | `2.44ms / 67.52ms`    | p50 improved, tail got noisier; likely still backlog-dominated                     |
| `t3code/perf-checkpoint-reactor-fanout`          | Optimization 1 | `create-turn-spam-8x`       | `thread.archive dispatch -> thread.archived` | `5.71ms / 50.80ms`    | `0.93ms / 17.98ms`    | meaningful improvement in typical and tail latency                                 |
| `t3code/perf-checkpoint-reactor-fanout`          | Optimization 1 | `mixed-stream-terminal-git` | `git.status`                                 | `150.08ms / 169.73ms` | `146.87ms / 170.45ms` | effectively unchanged                                                              |
| `t3code/perf-projection-thread-message-hot-path` | Optimization 2 | `create-turn-spam-8x`       | `thread.create dispatch -> thread.created`   | `3.61ms / 58.38ms`    | `2.38ms / 20.36ms`    | large tail reduction; `ack -> event` fell from `56.95ms` to `19.22ms`              |
| `t3code/perf-projection-thread-message-hot-path` | Optimization 2 | `create-turn-spam-8x`       | `thread.archive dispatch -> thread.archived` | `5.71ms / 50.80ms`    | `0.97ms / 16.53ms`    | consistent improvement over both baseline and Optimization 1                       |
| `t3code/perf-projection-thread-message-hot-path` | Optimization 2 | `mixed-stream-terminal-git` | `thread.create dispatch -> thread.created`   | `0.89ms / 1.57ms`     | `1.21ms / 4.50ms`     | slight noise increase, still effectively realtime                                  |
| `t3code/perf-projection-thread-message-hot-path` | Optimization 2 | `mixed-stream-terminal-git` | `git.status`                                 | `150.08ms / 169.73ms` | `141.05ms / 162.86ms` | modest improvement, likely secondary to lower orchestration pressure               |
| `t3code/perf-control-plane-priority-lane`        | Optimization 3 | `create-turn-spam-8x`       | `thread.create dispatch -> thread.created`   | `3.61ms / 58.38ms`    | `1.90ms / 26.57ms`    | queue prioritization mainly removed `ack -> event` delay (`0.11ms / 25.45ms`)      |
| `t3code/perf-control-plane-priority-lane`        | Optimization 3 | `create-turn-spam-8x`       | `thread.archive dispatch -> thread.archived` | `5.71ms / 50.80ms`    | `1.09ms / 12.60ms`    | best archive tail so far; user-visible control commands now preempt stream traffic |
| `t3code/perf-control-plane-priority-lane`        | Optimization 3 | `mixed-stream-terminal-git` | `thread.create dispatch -> thread.created`   | `0.89ms / 1.57ms`     | `1.16ms / 1.33ms`     | realistic mixed-load control-plane latency stays near-baseline                     |
| `t3code/perf-control-plane-priority-lane`        | Optimization 3 | `mixed-stream-terminal-git` | `git.status`                                 | `150.08ms / 169.73ms` | `156.29ms / 182.32ms` | no git improvement; likely unrelated measurement noise                             |

## Notes

- The initial perf suite is characterization-first. It should fail only on obvious hangs/timeouts while we collect stable p50/p95 numbers for this machine and repository.
- Each optimization will land on its own branch and append a new row here with the measured delta and artifact path.
- Current takeaway: the redline server-side repro is real. The biggest measured wins came from shrinking per-chunk projection cost and then prioritizing control-plane commands over internal stream traffic. The remaining work, if we keep pushing, is in worker topology and the provider-side queue hops rather than the websocket boundary itself.
