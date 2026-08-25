import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import S3TablesBindingsFunctionLive, {
  S3TablesBindingsFunction,
} from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "S3TablesBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy that the
// handler's `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine
// 4xx/assertion failure surfaces immediately.
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
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

describe.sequential("S3Tables Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "S3Tables test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("S3Tables test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* S3TablesBindingsFunction;
        }).pipe(Effect.provide(S3TablesBindingsFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `S3Tables test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `S3Tables test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 240_000 });

  describe("binding registration", () => {
    test.provider("all 6 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toHaveLength(6);
      }),
    );
  });

  describe("ListNamespaces", () => {
    test.provider("lists the bucket's namespaces", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/namespaces`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(response.names).toContain("bindings");
      }),
    );
  });

  describe("ListTables", () => {
    test.provider("lists the namespace's tables", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/tables`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(response.names).toContain("events");
      }),
    );
  });

  describe("GetTable", () => {
    test.provider("reads the bound table's details", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/table`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(response.name).toBe("events");
        expect(response.format).toBe("ICEBERG");
        expect(response.versionToken).toBeTruthy();
        expect(response.warehouseLocation).toMatch(/^s3:\/\//);
      }),
    );
  });

  describe("GetTableMetadataLocation + UpdateTableMetadataLocation", () => {
    test.provider("round-trips the Iceberg commit protocol", (_stack) =>
      Effect.gen(function* () {
        const current = (yield* send(
          HttpClientRequest.get(`${baseUrl}/metadata-location`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(current.versionToken).toBeTruthy();
        expect(current.warehouseLocation).toMatch(/^s3:\/\//);

        // The commit either succeeds (the service records the pointer) or is
        // rejected with a typed 4xx tag because the fixture didn't write a
        // real Iceberg metadata file first — both prove the IAM grant and
        // identifier injection (a grant gap would be a 500 AccessDenied).
        const commit = (yield* send(
          HttpClientRequest.post(`${baseUrl}/metadata-location/commit`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        if (commit.committed) {
          expect(commit.versionTokenChanged).toBe(true);
        } else {
          expect(["BadRequestException", "ConflictException"]).toContain(
            commit.errorTag,
          );
        }
      }),
    );
  });

  describe("GetTableMaintenanceJobStatus", () => {
    test.provider("reads the table's maintenance job statuses", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/maintenance-jobs`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(response.tableArn).toContain("/table/");
        expect(Array.isArray(response.jobs)).toBe(true);
      }),
    );
  });
});
