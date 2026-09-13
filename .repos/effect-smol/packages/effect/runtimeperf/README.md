# Effect Runtime Performance

This harness measures focused synchronous runtime paths in fresh Node
processes. It supports:

- focused Effect Schema diagnostics;
- the upstream Effect, Valibot and Zod benchmark matrix;
- paired comparisons between Git revisions or the current working tree.

Cross-library results are diagnostic. Effect base/head comparisons are the
authoritative measurement for source changes.

## Commands

Run the complete registry:

```sh
pnpm runtimeperf
```

Run the cases extracted from the `effect@beta`, Valibot and Zod adapters in
[`open-circle/schema-benchmarks`](https://github.com/open-circle/schema-benchmarks):

```sh
pnpm runtimeperf schema-benchmarks
pnpm runtimeperf-compare schema-benchmarks --base main --head HEAD
```

This suite covers every upstream timing case supported by those adapters:
schema and decoder initialization, validation, parsing and Standard Schema
with valid/invalid inputs and first/all error modes, plus BigInt codec
operations. The upstream bundle and stack reports are not throughput
benchmarks, and the adapters do not define the optional string-format cases.

Select a suite, fixture, shared scenario, tier, family or implementation:

```sh
pnpm runtimeperf schema
pnpm runtimeperf object-32-valid
pnpm runtimeperf schema/object-32-valid-effect
pnpm runtimeperf --family arrays
pnpm runtimeperf --implementation zod4
```

Override measurement settings:

```sh
pnpm runtimeperf object-32-valid --rounds 9 --time 500 --warmup-time 150
```

Compare Effect `HEAD` with the working tree:

```sh
pnpm runtimeperf-compare schema/object-32-valid-effect
```

Compare explicit refs:

```sh
pnpm runtimeperf-compare schema --base main --head HEAD
```

Only `--fail-on-regression` turns a statistically classified regression into a
non-zero comparison exit code. Worker, fixture, configuration and Git errors
always fail.

Reports are written under `tmp/runtimeperf/results/`. Temporary Git worktrees
are created under `tmp/runtimeperf/worktrees/` and removed in `finally`.

## Registry

`config.json` groups fixture cases by source file. Every case records:

- tier and family;
- covered Effect AST tags;
- operation and path;
- input size;
- implementation;
- a shared scenario name for cross-library comparisons.

The `schema` suite is Effect-only and retains targeted diagnostics for scaling,
template literals, unions, records, transformations, optional properties,
adapters, recursion and cold paths. The `schema-benchmarks` suite contains the
complete timing matrices exposed by the upstream Effect, Valibot and Zod
adapters.

Zod parsing cases import `zod/v4` and call `safeParse` with `{ jitless: true }`;
its Standard Schema and codec cases use their native APIs. Valibot uses the
corresponding `is`, `safeParse` and Standard Schema APIs. The focused Effect
adapter family measures the overhead of public APIs that wrap parser issues.

## Measurement model

Each worker validates the fixture before and after measuring. Calibration finds
a batch large enough for the configured target duration. Each implementation
uses its own calibrated batch and executes in a separate process, with rotating
order within the scenario.

Tinybench measures one synchronous batched task. The primary process result is:

```text
nsPerOp = totalTimeMs * 1_000_000 / (task.runs * batchSize)
```

Tinybench latency statistics are retained as diagnostics and normalized by the
batch size. Independent Node processes, not Tinybench samples, are the
statistical observations.

Base/head comparisons alternate execution order by round and analyze paired
log ratios with a deterministic bootstrap. The report keeps all raw worker
results so aggregates can be recalculated.

## Fixture contract

Each configured export is a factory:

```ts
type RuntimePerfCase = {
  readonly run: () => unknown
  readonly validate: (result: unknown) => void
}

type RuntimePerfCaseFactory = () => RuntimePerfCase
```

Construct schemas, steady-state adapters and deterministic inputs in the
factory. Cold fixtures deliberately construct them inside `run`. A fixture
must measure one named operation, perform no I/O and return no Promise.

## Validation

```sh
node --test packages/effect/runtimeperf/test/*.test.mts
pnpm exec dprint check package.json packages/effect/runtimeperf
```
