import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as dsql from "@distilled.cloud/aws/dsql";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Db } from "./fixtures/db";
import DsqlDirectFunctionLive, {
  DsqlDirectFunction,
} from "./fixtures/direct-handler";
import DsqlDrizzleFunctionLive, {
  DsqlDrizzleFunction,
} from "./fixtures/drizzle-handler";

// DSQL clusters are serverless and pay-per-use: provisioning reaches ACTIVE
// in seconds, so the FULL fixture (cluster + IAM roles + two Lambdas bundling
// pg/drizzle + live token-auth round-trips + destroy) measures ~30-40s wall —
// well inside the speed-doctrine budget, hence un-gated.
const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DSQLConnect");

let drizzleUrl: string;
let directUrl: string;
let clusterId: string | undefined;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

class FixtureReadinessFailed extends Data.TaggedError(
  "FixtureReadinessFailed",
)<{
  readonly status: number;
  readonly body: string;
}> {}

class ClusterStillPresent extends Data.TaggedError("ClusterStillPresent")<{
  readonly clusterId: string;
}> {}

// The fixtures surface every failure as a 500 (handler-level `Effect.orDie`).
// A 5xx here is a cold init or a first-connect transient — retry bounded;
// 4xx/assertion failures surface immediately.
const send = (request: () => HttpClientRequest.HttpClientRequest) =>
  Effect.suspend(() => HttpClient.execute(request())).pipe(
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
      schedule: Schedule.spaced("5 seconds"),
      times: 8,
    }),
  );

const postJson = (url: string, body: unknown) =>
  send(() =>
    HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body),
  ).pipe(Effect.flatMap((r) => r.json));

const waitForFixture = (url: string) =>
  Effect.suspend(() => HttpClient.get(url)).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.void
        : response.text.pipe(
            Effect.flatMap((body) => {
              const error: TransientUpstream | FixtureReadinessFailed =
                response.status >= 500
                  ? new TransientUpstream({ status: response.status, body })
                  : new FixtureReadinessFailed({
                      status: response.status,
                      body,
                    });
              return Effect.fail(error);
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "TransientUpstream",
      schedule: Schedule.spaced("5 seconds"),
      times: 18,
    }),
  );

describe("DSQL.Connect", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "DSQL.Connect setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "DSQL.Connect setup: deploying DSQL cluster + 2 Lambda fixtures",
      );
      const outputs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Db;
          const drizzleFn = yield* DsqlDrizzleFunction;
          const directFn = yield* DsqlDirectFunction;
          return {
            clusterId: cluster.clusterId,
            drizzleUrl: drizzleFn.functionUrl,
            directUrl: directFn.functionUrl,
          };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(DsqlDrizzleFunctionLive, DsqlDirectFunctionLive),
          ),
        ),
      );

      expect(outputs.drizzleUrl).toBeTruthy();
      expect(outputs.directUrl).toBeTruthy();
      drizzleUrl = outputs.drizzleUrl!.replace(/\/+$/, "");
      directUrl = outputs.directUrl!.replace(/\/+$/, "");
      clusterId = outputs.clusterId;

      // Function URL propagation + cold start + first token-auth connect.
      // Bounded: retry transient 5xx responses for at most 90 seconds. Each
      // attempt creates a fresh request; non-transient statuses fail directly.
      yield* waitForFixture(`${drizzleUrl}/health`);
      yield* Effect.logInfo(
        `DSQL.Connect setup: fixtures ready (cluster ${clusterId})`,
      );
    }),
    { timeout: 900_000 },
  );

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      // Out-of-band deletion check via distilled — a deleted DSQL
      // cluster is gone or reports DELETING/DELETED.
      if (clusterId) {
        yield* Core.withProviders(
          dsql.getCluster({ identifier: clusterId }).pipe(
            Effect.flatMap((cluster) =>
              cluster.status === "DELETING" || cluster.status === "DELETED"
                ? Effect.void
                : Effect.fail(
                    new ClusterStillPresent({ clusterId: clusterId! }),
                  ),
            ),
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            Effect.retry({
              while: (e) => e._tag === "ClusterStillPresent",
              schedule: Schedule.max([
                Schedule.spaced("5 seconds"),
                Schedule.recurs(12),
              ]),
            }),
          ),
          testOptions,
          sharedStack.name,
        );
      }
    }),
    { timeout: 900_000 },
  );

  test.provider(
    "Drizzle over DSQL.Connect round-trips CREATE TABLE / INSERT / SELECT",
    (_stack) =>
      Effect.gen(function* () {
        const setup = (yield* postJson(`${drizzleUrl}/setup`, {})) as {
          success: boolean;
        };
        expect(setup.success).toBe(true);

        const insert = (yield* postJson(`${drizzleUrl}/insert`, {
          id: 1,
          title: "first",
        })) as { success: boolean };
        expect(insert.success).toBe(true);

        const select = (yield* send(() =>
          HttpClientRequest.get(`${drizzleUrl}/select?id=1`),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          rows: { id: number; title: string }[];
        };
        expect(select.rows).toHaveLength(1);
        expect(select.rows[0]).toEqual({ id: 1, title: "first" });
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "resolves connection info with a fresh IAM auth token",
    (_stack) =>
      Effect.gen(function* () {
        const info = (yield* send(() =>
          HttpClientRequest.get(`${directUrl}/info`),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          host: string;
          port: number;
          database?: string;
          username?: string;
          hasPassword: boolean;
          ssl: boolean;
          urlScheme: string;
        };
        expect(info.host).toMatch(/^[a-z0-9]+\.dsql\.[a-z0-9-]+\.on\.aws$/);
        expect(info.port).toBe(5432);
        expect(info.database).toBe("postgres");
        expect(info.username).toBe("admin");
        expect(info.hasPassword).toBe(true);
        expect(info.ssl).toBe(true);
        expect(info.urlScheme).toBe("postgresql");
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "GetVpcEndpointServiceName binding resolves the PrivateLink service name",
    (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(() =>
          HttpClientRequest.get(`${directUrl}/vpc-endpoint-service`),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          serviceName: string;
          clusterVpcEndpoint: string | null;
        };
        expect(response.serviceName).toMatch(/^com\.amazonaws\./);
        expect(response.serviceName).toContain("dsql");
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "connects DIRECTLY to the public endpoint (raw pg, no Drizzle, no VPC)",
    (_stack) =>
      Effect.gen(function* () {
        const roundtrip = (yield* postJson(`${directUrl}/roundtrip`, {})) as {
          rows: { id: number; title: string }[];
          host: string;
        };
        expect(roundtrip.host).toMatch(/\.dsql\./);
        expect(roundtrip.rows).toHaveLength(1);
        expect(roundtrip.rows[0]).toEqual({ id: 1, title: "direct" });
      }),
    { timeout: 180_000 },
  );
});
