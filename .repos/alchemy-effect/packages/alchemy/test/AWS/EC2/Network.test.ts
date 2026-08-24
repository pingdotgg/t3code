import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "./VpcTest.ts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import NetworkTestFunctionLive, {
  NetworkTestFunction,
} from "./fixtures/network-function";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "EC2NetworkFunction");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take
// well over 60s on a fresh deploy — budget ~150s of readiness polling.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

describe("EC2.Network composed in a Lambda layer", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* NetworkTestFunction;
        }).pipe(Effect.provide(NetworkTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // The function role has NO ec2:Describe* permissions and the runtime
      // does not provide `AWSEnvironment` — a 200 here proves the `Network`
      // composition re-executes cleanly at Lambda init.
      yield* HttpClient.get(`${baseUrl}/network`).pipe(
        Effect.timeout("4 seconds"),
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    // This nested setup hook is scheduled while the file may still be queued
    // on the shared VPC-capacity lease. Give coordination the suite wall;
    // every cloud/HTTP wait inside remains independently bounded.
    { timeout: 3_600_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 240_000 });

  test.provider(
    "Lambda INITs cleanly and resolves Network outputs at runtime",
    (_stack) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get(`${baseUrl}/network`);
        expect(response.status).toBe(200);

        const body = (yield* response.json) as {
          vpcId: string;
          subnetId: string;
        };
        expect(body.vpcId).toMatch(/^vpc-/);
        expect(body.subnetId).toMatch(/^subnet-/);
      }),
    { timeout: 60_000 },
  );
});
