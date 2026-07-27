import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as rds from "@distilled.cloud/aws/rds";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import RDSDrizzleIamFunctionLive, {
  RDSDrizzleIamFunction,
} from "./drizzle-iam-handler";
import RDSDataTestFunctionLive, { RDSDataTestFunction } from "./handler";
import { reapRDSDataOrphans } from "./reap";

// Aurora Serverless v2 cluster + writer-instance provisioning takes 5-15
// minutes — far beyond the speed doctrine's budget — so the ENTIRE live suite
// (deploy hook, every test, destroy hook) is opt-in behind AWS_TEST_SLOW=1.
// A run without the env var is skip-clean: no AWS calls, no side effects.
const SLOW = !!process.env.AWS_TEST_SLOW;

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RDSDataBindings");

let baseUrl: string;
let drizzleUrl: string;
let clusterIdentifier: string | undefined;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

class ClusterStillPresent extends Data.TaggedError("ClusterStillPresent")<{
  readonly clusterIdentifier: string;
}> {}

// The fixture surfaces every failure as a 500 (handler-level `Effect.orDie`).
// A 5xx from this Lambda is either a cold re-init or an rds-data transient
// (DatabaseResumingException / DatabaseUnavailableException while the
// serverless cluster scales from idle) — retry those on a generous bounded
// schedule; a 4xx/assertion failure is surfaced immediately.
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
        Schedule.spaced("5 seconds"),
        Schedule.recurs(8),
      ]),
    }),
  );

const postJson = (url: string, body: unknown) =>
  send(
    HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body),
  ).pipe(Effect.flatMap((r) => r.json));

// The scratch stack's state store is IN MEMORY, so `sharedStack.destroy()`
// can only see resources deployed by THIS process. A previous run killed
// mid-deploy/mid-destroy (Aurora provisioning + teardown run 10+ minutes)
// leaves the whole VPC/RDS fixture orphaned with no state to destroy from.
// The reaper deletes fixture leftovers out-of-band by deterministic
// name-prefix / ownership tag; it runs as a pre-clean before deploy and as
// an `ensuring` finalizer after destroy.
const reapOrphans = Core.withProviders(
  reapRDSDataOrphans,
  testOptions,
  sharedStack.name,
);

describe("RDSData Bindings", () => {
  beforeAll(
    SLOW
      ? Effect.gen(function* () {
          yield* Effect.logInfo(
            "RDSData test setup: destroying previous resources",
          );
          yield* sharedStack.destroy();

          yield* Effect.logInfo(
            "RDSData test setup: reaping orphans from prior interrupted runs",
          );
          yield* reapOrphans;

          yield* Effect.logInfo(
            "RDSData test setup: deploying Aurora SV2 + Lambda fixture (5-15 min)",
          );
          const { dataApiUrl, drizzleIamUrl } = yield* sharedStack.deploy(
            Effect.gen(function* () {
              const dataApi = yield* RDSDataTestFunction;
              const drizzleIam = yield* RDSDrizzleIamFunction;
              return {
                dataApiUrl: dataApi.functionUrl,
                drizzleIamUrl: drizzleIam.functionUrl,
              };
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  RDSDataTestFunctionLive,
                  RDSDrizzleIamFunctionLive,
                ),
              ),
            ),
          );

          expect(dataApiUrl).toBeTruthy();
          expect(drizzleIamUrl).toBeTruthy();
          baseUrl = dataApiUrl!.replace(/\/+$/, "");
          drizzleUrl = drizzleIamUrl!.replace(/\/+$/, "");

          // Bounded readiness poll (gated-suite only): the cluster is already
          // `available` when deploy returns (the DBCluster/DBInstance
          // reconcilers wait for it), so this covers Lambda URL cold start
          // plus first Data API connection setup. Generous spaced schedule:
          // 10s x 42 ≈ 7 min ceiling.
          yield* HttpClient.get(`${baseUrl}/health`).pipe(
            Effect.flatMap((response) =>
              response.status === 200
                ? Effect.succeed(response)
                : Effect.fail(
                    new Error(`Fixture not ready: ${response.status}`),
                  ),
            ),
            Effect.tapError((error) =>
              Effect.logWarning(
                `RDSData test setup: fixture not ready yet (${String(error)})`,
              ),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.spaced("10 seconds"),
                Schedule.recurs(42),
              ]),
            }),
          );

          // Capture the cluster identifier so afterAll can verify deletion
          // out-of-band after destroy.
          const meta = (yield* HttpClient.get(`${baseUrl}/meta`).pipe(
            Effect.flatMap((r) => r.json),
          )) as { clusterIdentifier: string };
          clusterIdentifier = meta.clusterIdentifier;
          yield* Effect.logInfo(
            `RDSData test setup: fixture ready (cluster ${clusterIdentifier})`,
          );

          // Create the shared table once for all binding tests.
          yield* postJson(`${baseUrl}/setup`, {});

          // Bootstrap the IAM-auth DB user (rds_iam + table grants) via the
          // Data API — the VPC-attached Drizzle fixture can't reach the Data
          // API itself.
          yield* postJson(`${baseUrl}/setup-iam-user`, {});
        })
      : Effect.void,
    { timeout: 1_500_000 },
  );

  afterAll(
    SLOW
      ? Effect.gen(function* () {
          yield* sharedStack.destroy();

          // Out-of-band deletion check via distilled: the DBCluster provider
          // already waits until the cluster is gone, so this is a bounded
          // confirmation, not a long poll.
          if (clusterIdentifier) {
            yield* Core.withProviders(
              rds
                .describeDBClusters({ DBClusterIdentifier: clusterIdentifier })
                .pipe(
                  Effect.flatMap((response) =>
                    (response.DBClusters ?? []).length === 0
                      ? Effect.void
                      : Effect.fail(
                          new ClusterStillPresent({
                            clusterIdentifier: clusterIdentifier!,
                          }),
                        ),
                  ),
                  Effect.catchTag("DBClusterNotFoundFault", () => Effect.void),
                  Effect.retry({
                    schedule: Schedule.max([
                      Schedule.spaced("15 seconds"),
                      Schedule.recurs(8),
                    ]),
                  }),
                ),
              testOptions,
              sharedStack.name,
            );
          }
        }).pipe(
          // Always sweep out-of-band leftovers — even when destroy itself
          // fails partway (e.g. a lingering Lambda ENI blocking SG deletion).
          // Once this process exits, the in-memory state is gone and nothing
          // else can ever find these resources again.
          Effect.ensuring(reapOrphans.pipe(Effect.orDie)),
        )
      : Effect.void,
    { timeout: 1_500_000 },
  );

  describe("ExecuteStatement", () => {
    test.provider.skipIf(!SLOW)(
      "inserts and selects a row with typed parameters",
      (_stack) =>
        Effect.gen(function* () {
          const insert = (yield* postJson(`${baseUrl}/insert`, {
            id: 1,
            title: "first",
          })) as { success: boolean; numberOfRecordsUpdated: number };
          expect(insert.success).toBe(true);
          expect(insert.numberOfRecordsUpdated).toBe(1);

          const select = (yield* send(
            HttpClientRequest.get(`${baseUrl}/select?id=1`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            records: { longValue?: number; stringValue?: string }[][];
          };
          expect(select.records).toHaveLength(1);
          expect(select.records[0]![0]!.longValue).toBe(1);
          expect(select.records[0]![1]!.stringValue).toBe("first");
        }),
      { timeout: 120_000 },
    );

    test.provider.skipIf(!SLOW)(
      "returns no records for a missing row",
      (_stack) =>
        Effect.gen(function* () {
          const select = (yield* send(
            HttpClientRequest.get(`${baseUrl}/select?id=999999`),
          ).pipe(Effect.flatMap((r) => r.json))) as { records: unknown[] };
          expect(select.records).toHaveLength(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("BatchExecuteStatement", () => {
    test.provider.skipIf(!SLOW)(
      "inserts multiple rows via parameterSets",
      (_stack) =>
        Effect.gen(function* () {
          const batch = (yield* postJson(`${baseUrl}/batch-insert`, {
            rows: [
              { id: 10, title: "batch-a" },
              { id: 11, title: "batch-b" },
            ],
          })) as { updateResults: unknown[] };
          expect(batch.updateResults).toHaveLength(2);

          const select = (yield* send(
            HttpClientRequest.get(`${baseUrl}/select?id=11`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            records: { longValue?: number; stringValue?: string }[][];
          };
          expect(select.records[0]![1]!.stringValue).toBe("batch-b");
        }),
      { timeout: 120_000 },
    );
  });

  describe("BeginTransaction", () => {
    test.provider.skipIf(!SLOW)(
      "returns a transaction id",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* postJson(`${baseUrl}/tx-commit`, {
            id: 20,
            title: "begin",
          })) as { transactionId: string };
          expect(result.transactionId).toBeTruthy();
        }),
      { timeout: 120_000 },
    );
  });

  describe("CommitTransaction", () => {
    test.provider.skipIf(!SLOW)(
      "commits an insert so it is visible afterwards",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* postJson(`${baseUrl}/tx-commit`, {
            id: 30,
            title: "committed",
          })) as { transactionId: string; transactionStatus: string };
          expect(result.transactionId).toBeTruthy();

          const select = (yield* send(
            HttpClientRequest.get(`${baseUrl}/select?id=30`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            records: { longValue?: number; stringValue?: string }[][];
          };
          expect(select.records).toHaveLength(1);
          expect(select.records[0]![1]!.stringValue).toBe("committed");
        }),
      { timeout: 120_000 },
    );
  });

  describe("RollbackTransaction", () => {
    test.provider.skipIf(!SLOW)(
      "rolls back an insert so it never becomes visible",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* postJson(`${baseUrl}/tx-rollback`, {
            id: 40,
            title: "rolled-back",
          })) as { transactionId: string; transactionStatus: string };
          expect(result.transactionId).toBeTruthy();

          const select = (yield* send(
            HttpClientRequest.get(`${baseUrl}/select?id=40`),
          ).pipe(Effect.flatMap((r) => r.json))) as { records: unknown[] };
          expect(select.records).toHaveLength(0);
        }),
      { timeout: 120_000 },
    );
  });

  // RDS.Connect is not a Data API binding, but it targets the same cluster
  // and only resolves connection settings (endpoint + secret credentials), so
  // it shares this fixture instead of provisioning a second Aurora cluster.
  describe("RDS.Connect", () => {
    test.provider.skipIf(!SLOW)(
      "resolves host, port, database and credentials from the secret",
      (_stack) =>
        Effect.gen(function* () {
          const info = (yield* send(
            HttpClientRequest.get(`${baseUrl}/connect-info`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            host: string;
            port: number;
            database?: string;
            username?: string;
            hasPassword: boolean;
            ssl: boolean;
          };
          expect(info.host).toMatch(/\.rds\.amazonaws\.com$/);
          expect(info.port).toBe(5432);
          expect(info.database).toBe("app");
          expect(info.username).toBe("app");
          expect(info.hasPassword).toBe(true);
          expect(info.ssl).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });

  // IAM database authentication (db-drivers §3 "RDS/Aurora"): the deploy
  // half binds `rds-db:connect` on `dbuser:{resourceId}/app_iam` and attaches
  // the Lambda to the fixture VPC through the binding contract's `vpc`
  // channel (DECISION #5); the runtime half presigns a 15-minute token as the
  // password and `Drizzle.Postgres` consumes `ConnectionInfo.url` directly.
  describe("RDS.Connect (IAM auth)", () => {
    test.provider.skipIf(!SLOW)(
      "mints an IAM auth token as the password and can re-mint via refreshPassword",
      (_stack) =>
        Effect.gen(function* () {
          const info = (yield* send(
            HttpClientRequest.get(`${drizzleUrl}/connect-info`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            host: string;
            port: number;
            database?: string;
            username?: string;
            hasToken: boolean;
            ssl: boolean;
            canRefresh: boolean;
          };
          expect(info.host).toMatch(/\.rds\.amazonaws\.com$/);
          expect(info.port).toBe(5432);
          expect(info.database).toBe("app");
          expect(info.username).toBe("app_iam");
          expect(info.hasToken).toBe(true);
          expect(info.ssl).toBe(true);
          expect(info.canRefresh).toBe(true);
        }),
      { timeout: 120_000 },
    );

    test.provider.skipIf(!SLOW)(
      "Drizzle round-trips over the IAM-auth connection URL",
      (_stack) =>
        Effect.gen(function* () {
          // Socket sanity check first — TLS + token auth + in-VPC route.
          const health = (yield* send(
            HttpClientRequest.get(`${drizzleUrl}/drizzle-health`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            rows: { one: number }[];
          };
          expect(health.rows[0]?.one).toBe(1);

          // Cross-path consistency: write via the Data API Lambda, read over
          // the wire protocol from the VPC-attached Lambda.
          yield* postJson(`${baseUrl}/insert`, {
            id: 60,
            title: "written-via-data-api",
          });
          const todos = (yield* send(
            HttpClientRequest.get(`${drizzleUrl}/drizzle-todos`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            rows: { count: number }[];
          };
          expect(todos.rows[0]!.count).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 180_000 },
    );
  });

  // `ExecuteSql` is deprecated (Aurora Serverless v1 era API) — implemented
  // for completeness but intentionally not exercised against live AWS.
});
