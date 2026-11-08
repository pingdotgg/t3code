import * as AWS from "@alchemy.run/aws";
import { makeDynamoDBState, makeS3State } from "@alchemy.run/aws";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import type { StackServices } from "alchemy/Stack";
import type { ResourceState, StateService, StateStoreError } from "alchemy/State";
import type { State } from "alchemy/State/State";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

/**
 * Benchmarks the AWS state stores against each other.
 *
 * The store cases drive each store with the calls a plan makes (`list`, a
 * `get` per record, `getReplacedResources`, all unbounded, as `Plan.ts`
 * issues them) and the writes an apply makes. The stack cases deploy the
 * same Stack of SQS queues once per store.
 *
 * Timings go to the run log and to `.alchemy/benchmarks/state-store.md`.
 * Only correctness is asserted: wall-clock numbers vary too much between
 * runs to gate on.
 */

const { test, afterAll } = Test.make({ providers: AWS.providers() });

const tags = [
  "provider:aws",
  "provider:aws:dynamodb",
  "provider:aws:s3",
  "provider:aws:statestore",
  "benchmark",
  "live",
];

interface Row {
  readonly suite: string;
  readonly backend: string;
  readonly step: string;
  readonly ms: number;
}

const rows: Row[] = [];

/** Run `effect`, record how long it took, and return its result. */
const time = <A, E, R>(
  suite: string,
  backend: string,
  step: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.timed(effect).pipe(
    Effect.tap(([duration]) =>
      Effect.gen(function* () {
        const ms = Math.round(Duration.toMillis(duration));
        rows.push({ suite, backend, step, ms });
        yield* Effect.logInfo(`[bench] ${suite} | ${backend} | ${step}: ${ms}ms`);
      }),
    ),
    Effect.map(([, result]) => result),
  );

/** A resource state shaped like a real one, about `bytes` long encoded. */
const resource = (fqn: string, bytes: number, status = "created"): ResourceState =>
  ({
    resourceType: "AWS.Lambda.Function",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: `instance-${fqn}`,
    providerVersion: 1,
    status,
    downstream: [],
    bindings: [],
    props: { functionName: `${fqn}-function`, memorySize: 1024, timeout: 30 },
    attr: {
      functionArn: `arn:aws:lambda:us-west-2:123456789012:function:${fqn}`,
      padding: "x".repeat(Math.max(0, bytes - 400)),
    },
  }) as ResourceState;

const STACK = "StateStoreBenchmark";

interface Workload {
  readonly name: string;
  readonly records: number;
  readonly bytes: number;
}

const workloads: ReadonlyArray<Workload> = [
  { name: "50 records x 1 KiB", records: 50, bytes: 1024 },
  { name: "250 records x 1 KiB", records: 250, bytes: 1024 },
  // Above the DynamoDB store's 300 KiB threshold: every record overflows.
  { name: "10 records x 350 KiB", records: 10, bytes: 350 * 1024 },
];

/**
 * What a deploy does to the store: write every record, then a fresh
 * process plans (list + get all + replaced), plans again warm, and the
 * stage is destroyed.
 */
const runWorkload = Effect.fn(function* <R>(
  workload: Workload,
  backend: string,
  make: Effect.Effect<StateService, StateStoreError, R>,
) {
  const stage = `bench-${workload.records}-${workload.bytes}`;
  const values = Array.from({ length: workload.records }, (_, i) =>
    resource(`Resource${i}`, workload.bytes, i % 10 === 0 ? "replaced" : "created"),
  );
  const bench = <A, E, R>(step: string, effect: Effect.Effect<A, E, R>) =>
    time(workload.name, backend, step, effect);

  const plan = (state: StateService) =>
    Effect.gen(function* () {
      const fqns = yield* state.list({ stack: STACK, stage });
      const found = yield* Effect.forEach(fqns, (fqn) => state.get({ stack: STACK, stage, fqn }), {
        concurrency: "unbounded",
      });
      const replaced = yield* state.getReplacedResources({ stack: STACK, stage });
      return { found, replaced };
    });

  // Start from an empty stage.
  yield* Effect.scoped(Effect.flatMap(make, (state) => state.deleteStack({ stack: STACK, stage })));

  yield* Effect.scoped(
    Effect.gen(function* () {
      const state = yield* make;
      yield* bench(
        "write all (unbounded)",
        Effect.forEach(
          values,
          (value) => state.set({ stack: STACK, stage, fqn: value.fqn, value }),
          {
            concurrency: "unbounded",
          },
        ),
      );
      yield* bench(
        "update all (sequential)",
        Effect.forEach(
          values,
          (value) => state.set({ stack: STACK, stage, fqn: value.fqn, value }),
          {
            discard: true,
          },
        ),
      );
    }),
  );

  yield* Effect.scoped(
    Effect.gen(function* () {
      const state = yield* make;
      const cold = yield* bench("plan, cold (new store)", plan(state));
      expect(cold.found.filter((value) => value !== undefined)).toHaveLength(workload.records);
      expect(cold.replaced).toHaveLength(Math.ceil(workload.records / 10));
      const warm = yield* bench("plan, warm (same store)", plan(state));
      expect(warm.found).toHaveLength(workload.records);
      yield* bench("delete stage", state.deleteStack({ stack: STACK, stage }));
    }),
  );
});

const StoreStorage = Effect.gen(function* () {
  const table = yield* AWS.DynamoDB.Table("BenchTable", {
    partitionKey: "PK",
    sortKey: "SK",
    attributes: { PK: "S", SK: "S" },
  });
  const overflow = yield* AWS.S3.Bucket("BenchOverflow", { forceDestroy: true });
  const bucket = yield* AWS.S3.Bucket("BenchStateBucket", { forceDestroy: true });
  return {
    tableName: table.tableName,
    overflowBucket: overflow.bucketName,
    stateBucket: bucket.bucketName,
  };
});

describe.sequential("state store operations", { tags }, () => {
  test.provider.skipIf(!!process.env.FAST)(
    "S3 and DynamoDB stores under plan and apply workloads",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const storage = yield* stack.deploy(StoreStorage);
        for (const workload of workloads) {
          yield* runWorkload(
            workload,
            "s3",
            makeS3State({ bucketName: storage.stateBucket, prefix: "bench" }),
          );
          yield* runWorkload(
            workload,
            "dynamodb",
            makeDynamoDBState({
              tableName: storage.tableName,
              overflowBucketName: storage.overflowBucket,
              migrateFrom: false,
            }),
          );
        }
        yield* stack.destroy();
      }),
    { timeout: 900_000 },
  );
});

const QUEUES = 20;

/** The same Stack of SQS queues, named per store so the runs don't share state. */
const queueStack = <S extends Layer.Layer<State, never, StackServices>>(name: string, state: S) => {
  const options = { providers: AWS.providers(), state };
  return {
    harness: Test.make(options),
    stack: Alchemy.Stack(
      name,
      options,
      Effect.gen(function* () {
        const queues = yield* Effect.forEach(
          Array.from({ length: QUEUES }, (_, i) => i),
          (i) => AWS.SQS.Queue(`Queue${i}`),
          { concurrency: "unbounded" },
        );
        return { count: queues.length };
      }),
    ),
  };
};

const stacks = [
  { backend: "s3", ...queueStack("StateBenchS3", AWS.state({ backend: "s3" })) },
  { backend: "dynamodb", ...queueStack("StateBenchDynamoDB", AWS.state()) },
  { backend: "local", ...queueStack("StateBenchLocal", Alchemy.localState()) },
];

describe.sequential(
  `a Stack of ${QUEUES} SQS queues`,
  { tags: [...tags, "provider:aws:sqs"] },
  () => {
    for (const { backend, harness, stack } of stacks) {
      harness.test.skipIf(!!process.env.FAST)(
        `deploys, redeploys and destroys on the ${backend} store`,
        Effect.gen(function* () {
          const suite = `Stack of ${QUEUES} queues`;
          yield* harness.destroy(stack);
          const fresh = yield* time(suite, backend, "fresh deploy", harness.deploy(stack));
          expect(fresh.count).toBe(QUEUES);
          yield* time(suite, backend, "unchanged redeploy #1", harness.deploy(stack));
          yield* time(suite, backend, "unchanged redeploy #2", harness.deploy(stack));
          yield* time(suite, backend, "destroy", harness.destroy(stack));
        }),
        { timeout: 600_000 },
      );
    }
  },
);

/**
 * Stacks of `Alchemy.Random` resources: they live only in state, so these
 * cases measure the engine and the store at sizes a Stack of cloud
 * resources would take far longer (and cost more) to reach.
 */
const SIZES = [1_000, 5_000, 10_000];

const randomStack = <S extends Layer.Layer<State, never, StackServices>>(
  name: string,
  state: S,
  size: number,
) => {
  const options = { providers: AWS.providers(), state };
  return {
    harness: Test.make(options),
    stack: Alchemy.Stack(
      name,
      options,
      Effect.gen(function* () {
        const randoms = yield* Effect.forEach(
          Array.from({ length: size }, (_, i) => i),
          (i) => Alchemy.Random(`Random${i}`),
          { concurrency: "unbounded" },
        );
        return { count: randoms.length };
      }),
    ),
  };
};

describe.sequential("large Stacks", { tags }, () => {
  for (const size of SIZES) {
    const large = [
      { backend: "s3", ...randomStack(`StateBenchS3x${size}`, AWS.state({ backend: "s3" }), size) },
      {
        backend: "dynamodb",
        ...randomStack(`StateBenchDynamoDBx${size}`, AWS.state(), size),
      },
      { backend: "local", ...randomStack(`StateBenchLocalx${size}`, Alchemy.localState(), size) },
    ];
    for (const { backend, harness, stack } of large) {
      harness.test.skipIf(!!process.env.FAST)(
        `${size} resources deploy, redeploy and destroy on the ${backend} store`,
        Effect.gen(function* () {
          const suite = `Stack of ${size} resources`;
          yield* harness.destroy(stack);
          const fresh = yield* time(suite, backend, "fresh deploy", harness.deploy(stack));
          expect(fresh.count).toBe(size);
          yield* time(suite, backend, "unchanged redeploy", harness.deploy(stack));
          yield* time(suite, backend, "destroy", harness.destroy(stack));
        }),
        // S3 takes about half a second per resource per step.
        { timeout: size * 2_000 },
      );
    }
  }
});

/** One table per suite: a step per row, a store per column. */
const report = () => {
  const lines: string[] = ["# State store benchmark", ""];
  for (const suite of Array.from(new Set(rows.map((row) => row.suite)))) {
    const inSuite = rows.filter((row) => row.suite === suite);
    const backends = Array.from(new Set(inSuite.map((row) => row.backend)));
    lines.push(
      `## ${suite}`,
      "",
      `| step | ${backends.join(" | ")} |`,
      `|---|${backends.map(() => "---:").join("|")}|`,
    );
    for (const step of Array.from(new Set(inSuite.map((row) => row.step)))) {
      const cells = backends.map((backend) => {
        const row = inSuite.find((r) => r.backend === backend && r.step === step);
        return row === undefined ? "" : `${row.ms} ms`;
      });
      lines.push(`| ${step} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
};

afterAll(
  Effect.gen(function* () {
    if (rows.length === 0) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const markdown = report();
    yield* Effect.logInfo(`\n${markdown}`);
    const dir = path.join(yield* Effect.sync(() => process.cwd()), ".alchemy", "benchmarks");
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, "state-store.md"), markdown);
  }).pipe(Effect.orDie),
);
