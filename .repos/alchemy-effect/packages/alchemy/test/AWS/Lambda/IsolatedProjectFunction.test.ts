import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  materializeIsolatedProject,
  removeIsolatedProject,
} from "../../IsolatedProject.ts";
import IsolatedProjectFunctionLive, {
  BODY,
  IsolatedProjectFunction,
  project,
} from "./fixtures/isolated-project-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Live proof that the Lambda (zip) bootstrap loads when the function's
// `main` lives in an isolated project (see test/IsolatedProject.ts) — the
// bundle `cwd` resolves none of alchemy's dependencies, so the bootstrap's
// `@distilled.cloud/aws/*` / `@effect/platform-node` imports must be bundled
// by the virtual-entry plugin rather than found from the project root. With
// them left external the runtime fails at init (`Cannot find package`) and
// the function URL answers 5xx.
test.provider(
  "function bundled from an isolated project serves its URL",
  (stack) =>
    Effect.gen(function* () {
      yield* materializeIsolatedProject(project);
      yield* stack.destroy();

      try {
        const { functionName, functionUrl } = yield* stack.deploy(
          IsolatedProjectFunction.pipe(
            Effect.provide(IsolatedProjectFunctionLive),
          ),
        );
        expect(functionUrl).toBeTruthy();

        const response = yield* HttpClient.get(functionUrl!).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? Effect.succeed(res)
              : Effect.fail(new Error(`Function URL returned ${res.status}`)),
          ),
          // Bounded: a bootstrap that fails at init answers 5xx forever.
          Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 40 }),
        );
        expect(yield* response.text).toBe(BODY);

        yield* stack.destroy();
        // Out-of-band proof the destroy removed the function (bounded retry
        // to ride out delete propagation).
        yield* Lambda.getFunction({ FunctionName: functionName }).pipe(
          Effect.flatMap(() =>
            Effect.fail(new Error(`Function ${functionName} still exists`)),
          ),
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.exponential(500),
              Schedule.recurs(8),
            ]),
          }),
        );
      } finally {
        yield* removeIsolatedProject(project);
      }
    }),
  { timeout: 300_000 },
);
