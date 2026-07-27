import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as data from "@distilled.cloud/aws/redshift-data";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import RedshiftDataApiFunctionLive, {
  RedshiftDataApiFunction,
} from "./fixtures/data-api-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RedshiftDataClient");

// ---------------------------------------------------------------------------
// Ungated typed-error probes: prove the distilled redshift-data error union
// carries the tags the Statements client depends on, at near-zero cost.
// ---------------------------------------------------------------------------

test.provider(
  "describeStatement on a nonexistent statement fails with a typed error",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        data.describeStatement({
          Id: "d9b6c0c9-0747-4bf4-b142-e8883122f766",
        }),
      );
      expect(["ResourceNotFoundException", "ValidationException"]).toContain(
        error._tag,
      );
    }),
);

test.provider(
  "listDatabases against a nonexistent workgroup fails with a typed error",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        data.listDatabases({
          Database: "dev",
          WorkgroupName: "alchemy-test-rsd-does-not-exist",
        }),
      );
      expect([
        "ValidationException",
        "ResourceNotFoundException",
        "DatabaseConnectionException",
      ]).toContain(error._tag);
    }),
);

// ---------------------------------------------------------------------------
// Full live suite: deploys a Redshift Serverless namespace + workgroup (a
// real-money RPU floor while it exists) plus a Lambda, so it is gated behind
// AWS_TEST_SLOW=1 and destroys everything in afterAll. A run without the env
// var is skip-clean: no AWS calls, no side effects.
// ---------------------------------------------------------------------------

let baseUrl: string;

const get = (route: string) =>
  HttpClient.get(`${baseUrl}${route}`).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new Error(`${route} returned ${res.status}: ${body}`),
              ),
            ),
          ),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(8),
      ]),
    }),
    Effect.flatMap((res) => res.json),
  );

describe.skipIf(!process.env.AWS_TEST_SLOW)("RedshiftData client", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "RedshiftData client setup: destroying previous run",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("RedshiftData client setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* RedshiftDataApiFunction;
        }).pipe(Effect.provide(RedshiftDataApiFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      yield* Effect.logInfo(
        `RedshiftData client setup: function URL ready (${functionUrl})`,
      );
    }),
    // namespace (~1 min) + workgroup create (~2-5 min) + Lambda deploy.
    { timeout: 900_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 600_000 });

  test.provider(
    "query: execute + describe + getResult round-trip",
    (_stack) =>
      Effect.gen(function* () {
        const body = (yield* get("/query")) as {
          columns: (string | undefined)[];
          records: { longValue?: number }[][];
          totalNumRows: number;
        };
        expect(body.records).toHaveLength(1);
        expect(body.records[0][0]).toMatchObject({ longValue: 1 });
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "executeBatch: runs sub-statements and fetches a sub-statement result",
    (_stack) =>
      Effect.gen(function* () {
        const body = (yield* get("/batch")) as {
          status: string;
          subStatementCount: number;
          secondRecords: { longValue?: number }[][] | undefined;
        };
        expect(body.status).toBe("FINISHED");
        expect(body.subStatementCount).toBe(2);
        expect(body.secondRecords?.[0]?.[0]).toMatchObject({ longValue: 2 });
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "metadata: listDatabases + listSchemas + listTables + describeTable",
    (_stack) =>
      Effect.gen(function* () {
        const body = (yield* get("/metadata")) as {
          databases: string[];
          schemas: string[];
          tables: string[];
          columnCount: number;
        };
        expect(body.databases).toContain("dev");
        expect(body.schemas).toContain("pg_catalog");
        expect(body.tables).toContain("pg_class");
        expect(body.columnCount).toBeGreaterThan(0);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "listStatements: sees the caller's submitted statement",
    (_stack) =>
      Effect.gen(function* () {
        const body = (yield* get("/statements")) as {
          count: number;
          hasSubmitted: boolean;
        };
        expect(body.count).toBeGreaterThan(0);
        expect(body.hasSubmitted).toBe(true);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "cancel: cancellation request round-trips",
    (_stack) =>
      Effect.gen(function* () {
        const body = (yield* get("/cancel")) as { canceled: boolean };
        // Cancellation races completion; either outcome proves the wiring.
        expect(typeof body.canceled).toBe("boolean");
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "getResultV2: CSV result format round-trips",
    (_stack) =>
      Effect.gen(function* () {
        const body = (yield* get("/result-v2")) as {
          status: string;
          resultFormat: string | undefined;
          records: { CSVRecords?: string }[];
        };
        expect(body.status).toBe("FINISHED");
        expect(body.records.length).toBeGreaterThan(0);
        expect(body.records[0]?.CSVRecords).toContain("7");
      }),
    { timeout: 240_000 },
  );
});
