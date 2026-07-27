import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as securitylake from "@distilled.cloud/aws/securitylake";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import SecurityLakeBindingsFunctionLive, {
  SecurityLakeBindingsFunction,
} from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// Enabling Security Lake onboards the whole account in the Region (S3
// buckets, Lake Formation, Glue metastore), so the live Lambda E2E is gated
// behind AWS_TEST_SECURITYLAKE=1 like the lifecycle test.
const RUN_LIVE = !!process.env.AWS_TEST_SECURITYLAKE;

// Ungated typed-error probes: prove the distilled error unions the bindings
// depend on are typed on every account, onboarded or not, at near-zero cost.
test.provider(
  "listDataLakeExceptions returns exceptions or a typed not-onboarded rejection",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        securitylake.listDataLakeExceptions({}),
      );
      if (Result.isSuccess(result)) {
        expect(Array.isArray(result.success.exceptions ?? [])).toBe(true);
      } else {
        expect([
          "AccessDeniedException",
          "ResourceNotFoundException",
          "UnauthorizedException",
        ]).toContain(result.failure._tag);
      }
    }),
);

test.provider(
  "getDataLakeSources returns sources or a typed not-onboarded rejection",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(securitylake.getDataLakeSources({}));
      if (Result.isSuccess(result)) {
        expect(Array.isArray(result.success.dataLakeSources ?? [])).toBe(true);
      } else {
        expect([
          "AccessDeniedException",
          "ResourceNotFoundException",
          "UnauthorizedException",
        ]).toContain(result.failure._tag);
      }
    }),
);

const sharedStack = Core.scratchStack(testOptions, "SecurityLakeBindings");

let baseUrl: string;

const get = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));

describe("SecurityLake Bindings (E2E)", () => {
  beforeAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* Effect.logInfo("SecurityLake E2E setup: destroying previous run");
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "SecurityLake E2E setup: deploying data lake + Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SecurityLakeBindingsFunction;
        }).pipe(Effect.provide(SecurityLakeBindingsFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/bindings`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(60),
          ]),
        }),
      );
    }),
    { timeout: 600_000 },
  );
  afterAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* sharedStack.destroy();
    }),
    { timeout: 600_000 },
  );

  test.provider.skipIf(!RUN_LIVE)(
    "both capabilities initialize in the runtime",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(2);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "ListDataLakeExceptions grant + call round-trips from the Lambda",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/exceptions")) as { count: number };
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "GetDataLakeSources grant + call round-trips from the Lambda",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/sources")) as {
          dataLakeArn: string | undefined;
          count: number;
        };
        expect(response.dataLakeArn).toContain(":securitylake:");
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
  );
});
