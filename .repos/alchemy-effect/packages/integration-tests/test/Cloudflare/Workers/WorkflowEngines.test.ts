import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { inMemoryState } from "alchemy/State";
import type { Status } from "alchemy/Workflows";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { conformance } from "../../Workflows/conformance/conformance.ts";
import makeStack from "./fixtures/durable-workflow/stack.ts";

class NotReady extends Data.TaggedError("NotReady")<{ readonly message: string }> {}

/** A fixture route's body, failing with `NotReady` until it answers 200. */
const fetchText = (url: string, method: "GET" | "POST" = "GET") =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* method === "POST" ? client.post(url) : client.get(url);
    const body = yield* response.text;
    if (response.status !== 200) {
      return yield* new NotReady({ message: `${method} ${url}: HTTP ${response.status}: ${body}` });
    }
    return body;
  });

describe.concurrent.each([
  { engine: "durable-object", dev: true, stage: `${Test.defaultStage()}-durable-workflow-local` },
  { engine: "durable-object", dev: false, stage: `${Test.defaultStage()}-durable-workflow-live` },
  {
    engine: "durable-object-eu",
    dev: true,
    stage: `${Test.defaultStage()}-durable-workflow-eu-local`,
  },
  {
    engine: "durable-object-eu",
    dev: false,
    stage: `${Test.defaultStage()}-durable-workflow-eu-live`,
  },
  { engine: "native", dev: true, stage: `${Test.defaultStage()}-native-engine-local` },
  { engine: "native", dev: false, stage: `${Test.defaultStage()}-native-engine-live` },
] as const)("Workflows on the $engine engine (dev: $dev)", ({ engine, dev, stage }) => {
  const state = dev ? inMemoryState() : Cloudflare.state();
  const Stack = makeStack(state, engine);
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
    state,
    dev,
    stage,
  });

  const stack = beforeAll(
    Effect.gen(function* () {
      yield* destroy(Stack);
      const output = yield* deploy(Stack);
      // A fresh workers.dev URL can take a while to start serving.
      yield* fetchText(`${output.url}/ready`).pipe(
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
      );
      // A Workflow class can take a while to reach every Worker version after
      // a deploy: wait until a run actually completes.
      yield* Effect.gen(function* () {
        const id = `probe-${crypto.randomUUID().slice(0, 8)}`;
        const { executionId } = JSON.parse(
          yield* fetchText(`${output.url}/start/Greet/${id}`, "POST"),
        ) as { executionId: string };
        yield* Effect.gen(function* () {
          const status = JSON.parse(
            yield* fetchText(`${output.url}/status/Greet/${id}?executionId=${executionId}`),
          ) as Status<unknown, unknown>;
          if (status._tag !== "Completed") {
            return yield* new NotReady({ message: JSON.stringify(status) });
          }
        }).pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }));
      }).pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 10 }));
      return output;
    }),
    { timeout: 240_000 },
  );
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 60_000 });

  conformance({
    test,
    url: Effect.map(stack, ({ url }) => url.replace(/\/+$/, "")),
    napsWithinMillis: 20_000,
    // The Durable Object engine retries a run with its alarm backoff: 5 then
    // 10 seconds, then the one-second sleep. Cloudflare Workflows retries a
    // step with its own policy.
    recoveryWithinMillis: engine === "native" ? undefined : 30_000,
    timeout: 90_000,
    unsupported: engine === "native" ? { raceAll: "aren't supported on Cloudflare Workflows" } : {},
  });
});
