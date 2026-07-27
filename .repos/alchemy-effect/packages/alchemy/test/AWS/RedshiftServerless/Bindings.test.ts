import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import RedshiftQueryFunctionLive, {
  RedshiftQueryFunction,
} from "./fixtures/query-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RedshiftDataBindings");

let baseUrl: string;

// The whole flagship suite deploys a Redshift Serverless namespace + workgroup
// (a real-money RPU floor while it exists) plus a Lambda, so it is gated behind
// AWS_TEST_SLOW=1 and destroys everything in afterAll.
describe.skipIf(!process.env.AWS_TEST_SLOW)("RedshiftData Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("RedshiftData test setup: destroying previous run");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("RedshiftData test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* RedshiftQueryFunction;
        }).pipe(Effect.provide(RedshiftQueryFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      yield* Effect.logInfo(
        `RedshiftData test setup: function URL ready (${functionUrl})`,
      );
    }),
    // namespace (~1 min) + workgroup create (~2-5 min) + Lambda deploy.
    { timeout: 900_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 600_000 });

  describe("Statements", () => {
    test.provider(
      "runs SELECT 1 against the serverless workgroup and returns records",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* HttpClient.get(`${baseUrl}/query`).pipe(
            Effect.flatMap((res) =>
              res.status === 200
                ? Effect.succeed(res)
                : Effect.fail(new Error(`query returned ${res.status}`)),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("1 second"),
                Schedule.recurs(10),
              ]),
            }),
            Effect.flatMap((res) => res.json),
          );

          const body = response as {
            columns: (string | undefined)[];
            records: { longValue?: number }[][];
            totalNumRows: number;
          };
          // SELECT 1 AS n => one row, one column, longValue 1.
          expect(body.records).toHaveLength(1);
          expect(body.records[0][0]).toMatchObject({ longValue: 1 });
        }),
      { timeout: 240_000 },
    );
  });
});
