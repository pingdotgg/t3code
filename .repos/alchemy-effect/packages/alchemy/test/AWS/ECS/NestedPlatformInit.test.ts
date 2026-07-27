import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import NestedEcsReproFunctionLive, {
  NestedEcsReproFunction,
} from "./fixtures/nested-ecs-lambda.ts";

// Regression for the "Platform-in-Platform init OOM": a Platform (ECS.Task)
// yielded DIRECTLY inside another Platform's (Lambda.Function) init program.
// Before the fix, the nested Task's ConfigProvider interceptor recursed back
// through the outer Lambda's interceptor at runtime (`ctx.get` → `Config` →
// interceptor → `ctx.get` …), growing the heap without bound until the Lambda
// sandbox died with `Runtime.OutOfMemory` at init.
//
// The fixture removes the `Resource.ref` workaround the ECS Bindings handler
// uses. If the nested-Platform init still OOMed, the deployed Lambda would
// never boot and this fetch would never return 200.
const testOptions = { providers: AWS.providers() };
const { beforeAll, afterAll, test } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "NestedPlatformInit");

let baseUrl: string;

// Fresh workers/Lambda URLs take a few seconds to start serving 200s; a
// sandbox that OOMs at init keeps returning 5xx until the readiness budget is
// exhausted, which fails the suite loudly.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(10),
]);

describe.sequential("ECS Nested Platform Init", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("nested-platform setup: destroying previous stack");
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "nested-platform setup: deploying nested-Task Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* NestedEcsReproFunction;
        }).pipe(Effect.provide(NestedEcsReproFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* Effect.logInfo(
        `nested-platform setup: probing readiness at ${baseUrl}`,
      );
      yield* HttpClient.get(baseUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `nested-platform setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      yield* Effect.logInfo("nested-platform setup: fixture ready");
    }),
    { timeout: 180_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 180_000 });

  test(
    "nested Platform (ECS.Task in Lambda) init does not OOM the sandbox",
    Effect.gen(function* () {
      const response = yield* HttpClient.get(baseUrl);
      expect(response.status).toBe(200);
      const body = (yield* response.json) as {
        ok?: boolean;
        taskType?: string;
        containerName?: string;
      };
      expect(body.ok).toBe(true);
      expect(body.taskType).toBe("AWS.ECS.Task");
      expect(body.containerName).toBeTruthy();
    }),
    { timeout: 120_000 },
  );
});
