import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as athena from "@distilled.cloud/aws/athena";
import * as glue from "@distilled.cloud/aws/glue";

import AthenaTestFunctionLive, { AthenaTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AthenaQuery");

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Fresh Lambda role + Athena/S3 permissions propagate eventually — the first
// queries can 500 with AccessDenied under the handler's `Effect.orDie`.
// Retry 5xx only; a genuine 4xx fails immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      // Bounded well under the 180s test timeout (~31s of sleeps) so a
      // persistent 500 surfaces its body instead of an opaque timeout.
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(5),
      ]),
    }),
  );

describe("Athena Query", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Athena Query setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "Athena Query setup: deploying bucket -> Glue db/table -> workgroup -> Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AthenaTestFunction;
        }).pipe(Effect.provide(AthenaTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/nope`).pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(75),
          ]),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  // No NO_DESTROY escape hatch here: scratch-stack state is in-memory per
  // process, so a skipped destroy would orphan the whole stack forever.
  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      // Assert-gone out-of-band via the fixture's fixed-name resources —
      // engine-named resources (bucket/workgroup/Lambda) hang off the same
      // stack, so these two vanishing proves the destroy actually ran.
      // `afterAll` effects don't get the providers layer automatically the
      // way `test.provider` bodies do, so wrap the distilled calls in
      // `Core.withProviders` to supply AWS credentials.
      yield* Core.withProviders(
        Effect.gen(function* () {
          const db = yield* glue
            .getDatabase({ Name: "alchemy_athena_e2e" })
            .pipe(
              Effect.map((res) => res.Database),
              Effect.catchTag("EntityNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          expect(db).toBeUndefined();

          const catalog = yield* athena
            .getDataCatalog({
              Name: "alchemy_athena_e2e_catalog",
              WorkGroup: "primary",
            })
            .pipe(
              Effect.map((res) => res.DataCatalog),
              Effect.catchTag("DataCatalogNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          expect(catalog).toBeUndefined();
        }),
        testOptions,
        sharedStack.name,
      );
    }),
    { timeout: 300_000 },
  );

  test.provider(
    "runs SELECT 1 through the binding (execute + poll + results)",
    () =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/select-one`),
        );
        expect(response.status).toBe(200);
        const body = (yield* response.json) as {
          state: string;
          columns: string[];
          rows: string[][];
        };
        expect(body.state).toBe("SUCCEEDED");
        // SELECT 1 → header row then the value row.
        expect(body.rows.at(-1)?.[0]).toBe("1");
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "runs SELECT COUNT(*) over a Glue table on S3 CSV data",
    () =>
      Effect.gen(function* () {
        // Seed the CSV source data first.
        const seeded = yield* send(HttpClientRequest.post(`${baseUrl}/seed`));
        expect(seeded.status).toBe(200);

        const response = yield* send(HttpClientRequest.get(`${baseUrl}/count`));
        expect(response.status).toBe(200);
        const body = (yield* response.json) as {
          state: string;
          columns: string[];
          rows: string[][];
        };
        expect(body.state).toBe("SUCCEEDED");
        // Three CSV rows → COUNT(*) = 3 (last row is the value, first is header).
        expect(body.rows.at(-1)?.[0]).toBe("3");
      }),
    { timeout: 180_000 },
  );

  // One completed SELECT 1 execution shared by every query-execution binding
  // below (each vitest file runs its tests sequentially).
  let execId: string | undefined;
  const ensureExecId = Effect.gen(function* () {
    if (execId) return execId;
    const response = yield* send(HttpClientRequest.get(`${baseUrl}/exec/run`));
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { id: string };
    execId = body.id;
    return body.id;
  });

  describe("GetQueryExecution", () => {
    test.provider(
      "reads the execution's terminal state",
      () =>
        Effect.gen(function* () {
          const id = yield* ensureExecId;
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/exec/get?id=${id}`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as {
            state: string;
            workGroup: string;
          };
          expect(body.state).toBe("SUCCEEDED");
          expect(body.workGroup).toBeTruthy();
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetQueryResults", () => {
    test.provider(
      "reads the raw result page",
      () =>
        Effect.gen(function* () {
          const id = yield* ensureExecId;
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/exec/results?id=${id}`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as {
            rows: number;
            columns: string[];
          };
          // SELECT 1 → header row + value row.
          expect(body.rows).toBe(2);
          expect(body.columns.length).toBe(1);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetQueryRuntimeStatistics", () => {
    test.provider(
      "reads the execution timeline",
      () =>
        Effect.gen(function* () {
          const id = yield* ensureExecId;
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/exec/stats?id=${id}`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { totalMillis: number };
          expect(body.totalMillis).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("BatchGetQueryExecution", () => {
    test.provider(
      "reads executions in bulk",
      () =>
        Effect.gen(function* () {
          const id = yield* ensureExecId;
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/exec/batch?id=${id}`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { states: string[] };
          expect(body.states).toEqual(["SUCCEEDED"]);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListQueryExecutions", () => {
    test.provider(
      "lists the workgroup's executions (workgroup injected)",
      () =>
        Effect.gen(function* () {
          const id = yield* ensureExecId;
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/exec/list`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { ids: string[] };
          expect(body.ids).toContain(id);
        }),
      { timeout: 120_000 },
    );
  });

  describe("StopQueryExecution", () => {
    test.provider(
      "stop on a completed execution is an idempotent no-op",
      () =>
        Effect.gen(function* () {
          const id = yield* ensureExecId;
          const stopped = yield* send(
            HttpClientRequest.post(`${baseUrl}/exec/stop?id=${id}`),
          );
          expect(stopped.status).toBe(200);
          // Still SUCCEEDED — stop did not flip a terminal state.
          const after = yield* send(
            HttpClientRequest.get(`${baseUrl}/exec/get?id=${id}`),
          );
          const body = (yield* after.json) as { state: string };
          expect(body.state).toBe("SUCCEEDED");
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListNamedQueries", () => {
    test.provider(
      "lists the workgroup's saved queries (workgroup injected)",
      () =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/named/list`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { ids: string[] };
          // The fixture saves exactly one named query in the (fresh) workgroup.
          expect(body.ids.length).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListPreparedStatements", () => {
    test.provider(
      "lists the workgroup's prepared statements (workgroup injected)",
      () =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/prepared/list`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { names: string[] };
          expect(body.names).toContain("alchemy_athena_e2e_stmt");
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListDatabases", () => {
    test.provider(
      "lists databases through the GLUE-backed catalog",
      () =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/catalog/databases`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { names: string[] };
          expect(body.names).toContain("alchemy_athena_e2e");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetDatabase", () => {
    test.provider(
      "reads a single database's metadata",
      () =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/catalog/database?name=alchemy_athena_e2e`,
            ),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { name: string };
          expect(body.name).toBe("alchemy_athena_e2e");
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListTableMetadata", () => {
    test.provider(
      "lists the database's tables",
      () =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/catalog/tables?db=alchemy_athena_e2e`,
            ),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { names: string[] };
          expect(body.names).toContain("people");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetTableMetadata", () => {
    test.provider(
      "reads a table's columns",
      () =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/catalog/table?db=alchemy_athena_e2e&name=people`,
            ),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { columns: string[] };
          expect(body.columns).toEqual(["id", "name"]);
        }),
      { timeout: 120_000 },
    );
  });

  describe("QueryStateChangeEventSource", () => {
    test.provider(
      "delivers query state-change events to the handler",
      () =>
        Effect.gen(function* () {
          // The probe runs a query and polls S3 for the marker the event
          // handler writes; retry the whole probe a few times to ride out
          // fresh-rule propagation on the default bus.
          const seen = yield* Effect.gen(function* () {
            const response = yield* send(
              HttpClientRequest.get(`${baseUrl}/events/probe`),
            );
            expect(response.status).toBe(200);
            const body = (yield* response.json) as {
              seen: boolean;
              id: string;
            };
            return body.seen;
          }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (s): boolean => s,
              times: 3,
            }),
          );
          expect(seen).toBe(true);
        }),
      { timeout: 180_000 },
    );
  });
});
