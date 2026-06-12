import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";
import { WORKFLOW_SECRET_VALUE } from "../src/NotifyWorkflow.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  dev: true,
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deploys all workers with URLs",
  Effect.gen(function* () {
    const { asyncWorker, effectWorker } = yield* stack;

    expect(asyncWorker).toBeString();
    expect(effectWorker).toBeString();
  }),
);

/**
 * AsyncWorker exports a default fetch handler that calls the `Counter`
 * Durable Object's `increment()` and returns `Hello, world! <n>`.
 *
 * Hitting the worker twice exercises the DO end-to-end and proves
 * persistent state across requests — if the DO binding is missing or
 * the class export is wrong, the first request fails outright.
 */
test(
  "AsyncWorker increments the Counter Durable Object across requests",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;
    const url = asyncWorker!;

    const first = yield* HttpClient.get(url);
    expect(first.status).toBe(200);
    const firstBody = yield* first.text;
    const firstMatch = firstBody.match(/^Hello, world! (\d+)$/);
    expect(firstMatch).not.toBeNull();
    const firstCount = Number(firstMatch![1]);

    const second = yield* HttpClient.get(url);
    expect(second.status).toBe(200);
    const secondBody = yield* second.text;
    const secondMatch = secondBody.match(/^Hello, world! (\d+)$/);
    expect(secondMatch).not.toBeNull();
    const secondCount = Number(secondMatch![1]);

    expect(secondCount).toBe(firstCount + 1);
  }),
);

test(
  "AsyncWorker receives bindings, including variables and secrets",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;
    const response = yield* HttpClient.get(new URL("/env", asyncWorker!));
    expect(response.status).toBe(200);
    const body = yield* response.json;
    expect(body).toMatchObject({
      MY_SECRET: "my-secret-abc123",
      MY_VARIABLE: "my-variable-abc123",
      COUNTER: {},
    });
  }),
);

/**
 * EffectWorker binds a KV namespace via `Cloudflare.KVNamespace.bind(KV)`
 * and returns the result of `kv.list()` as JSON. A successful response
 * proves the Effect-style binding wired the runtime SDK and the
 * `WorkerEnvironment` service was provisioned for the fetch handler.
 */
test(
  "EffectWorker returns a KV list result via the Effect KV binding",
  Effect.gen(function* () {
    const { effectWorker } = yield* stack;

    const response = yield* HttpClient.get(effectWorker!);
    expect(response.status).toBe(200);

    const body = (yield* response.json) as {
      keys: Array<{ name: string }>;
      list_complete: boolean;
    };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(typeof body.list_complete).toBe("boolean");
  }),
);

/**
 * Both workers import `./modules/wasm-example.wasm`, which exports a
 * single `add(a: number, b: number): number` function. Hitting `/wasm`
 * instantiates the module and returns `add(3, 4)` as JSON, proving that
 * the bundler ships the wasm asset to workerd and that runtime
 * `WebAssembly.instantiate` works for both the raw async-handler and
 * Effect-style entrypoints.
 */
test(
  "AsyncWorker /wasm instantiates the wasm module and returns add(3, 4)",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;

    const response = yield* HttpClient.get(new URL("/wasm", asyncWorker!));
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { result: number };
    expect(body.result).toBe(7);
  }),
);

test(
  "EffectWorker /wasm instantiates the wasm module and returns add(3, 4)",
  Effect.gen(function* () {
    const { effectWorker } = yield* stack;

    const response = yield* HttpClient.get(new URL("/wasm", effectWorker!));
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { result: number };
    expect(body.result).toBe(7);
  }),
);

interface WorkflowStatus {
  status: string;
  output?: { text?: string; secret?: string; ts?: number };
  error?: { name: string; message: string } | null;
}

/**
 * Start a `NotifyWorkflow` instance through `workerUrl` and poll its status
 * until the instance reaches a terminal state. Asserts the workflow ran the
 * KV roundtrip task (`Processed: <message>`) and resolved the plantime-bound
 * `Alchemy.Secret` at runtime (`output.secret === WORKFLOW_SECRET_VALUE`).
 */
const exerciseWorkflow = (workerUrl: string, label: string) =>
  Effect.gen(function* () {
    const roomId = `${label}-${Math.random().toString(36).slice(2, 10)}`;

    const startResponse = yield* HttpClient.post(
      new URL(`/workflow/start/${roomId}`, workerUrl),
    );
    expect(startResponse.status).toBe(200);
    const { instanceId } = (yield* startResponse.json) as {
      instanceId: string;
    };
    expect(instanceId).toBeString();

    const statusUrl = new URL(`/workflow/status/${instanceId}`, workerUrl);
    const fetchStatus = HttpClient.get(statusUrl).pipe(
      Effect.flatMap((res) => res.json),
      Effect.map((json) => json as unknown as WorkflowStatus),
    );
    const status = yield* fetchStatus.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (s: WorkflowStatus) =>
          s.status === "complete" || s.status === "errored",
        times: 60,
      }),
    );

    expect(status.error).toBeFalsy();
    expect(status.status).toBe("complete");
    expect(status.output?.secret).toBe(WORKFLOW_SECRET_VALUE);
    expect(status.output?.text).toBe("Processed: hello from workflow");
  });

/**
 * EffectWorker `/workflow/start/:roomId` kicks off `NotifyWorkflow`, which
 * does a KV roundtrip task and resolves the `WORKFLOW_SECRET` `Alchemy.Secret`
 * at runtime. The status route surfaces the workflow output so we can assert
 * the workflow actually executed end-to-end (not just that it was scheduled).
 */
test(
  "EffectWorker drives NotifyWorkflow to completion with secret + KV roundtrip",
  Effect.gen(function* () {
    const { effectWorker } = yield* stack;
    yield* exerciseWorkflow(effectWorker!, "effect");
  }),
  { timeout: 180_000 },
);
