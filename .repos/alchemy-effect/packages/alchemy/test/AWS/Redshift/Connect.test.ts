import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as redshift from "@distilled.cloud/aws/redshift";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import RedshiftConnectFunctionLive, {
  RedshiftConnectFunction,
} from "./fixtures/connect-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RedshiftConnect");

// Ungated typed-error probes: prove the distilled error unions carry the
// not-found tag both Connect credential strategies can surface. Run in every
// CI pass at near-zero cost.
test.provider(
  "getClusterCredentialsWithIAM on a nonexistent cluster fails with ClusterNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        redshift.getClusterCredentialsWithIAM({
          ClusterIdentifier: "alchemy-nonexistent-redshift-connect-probe",
        }),
      );
      expect(error._tag).toBe("ClusterNotFoundFault");
    }),
);

test.provider(
  "getClusterCredentials on a nonexistent cluster fails with ClusterNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        redshift.getClusterCredentials({
          ClusterIdentifier: "alchemy-nonexistent-redshift-connect-probe",
          DbUser: "probe",
        }),
      );
      expect(error._tag).toBe("ClusterNotFoundFault");
    }),
);

let baseUrl: string;

const getInfo = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : Effect.fail(new Error(`${path} returned ${res.status}`)),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(10),
      ]),
    }),
    Effect.flatMap((res) => res.json),
    Effect.map(
      (body) =>
        body as {
          host: string;
          port: number;
          database: string;
          username: string | undefined;
          hasPassword: boolean;
          ssl: boolean;
          urlScheme: string;
          expiresInFuture: boolean;
        },
    ),
  );

// The full lifecycle deploys a provisioned Redshift cluster (~5-10 min to
// reach `available`, bills hourly per node while it exists) plus a Lambda,
// so it is gated behind AWS_TEST_REDSHIFT=1 and destroys everything in
// afterAll.
describe.skipIf(!process.env.AWS_TEST_REDSHIFT)("Redshift.Connect", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Redshift.Connect setup: destroying previous run");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Redshift.Connect setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* RedshiftConnectFunction;
        }).pipe(Effect.provide(RedshiftConnectFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      yield* Effect.logInfo(
        `Redshift.Connect setup: function URL ready (${functionUrl})`,
      );
    }),
    // cluster create (~5-10 min) + Lambda deploy.
    { timeout: 1_200_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 900_000 });

  describe("Connect", () => {
    test.provider(
      "mints IAM-mapped temporary credentials (GetClusterCredentialsWithIAM)",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* getInfo("/info");
          expect(body.host).toContain("redshift");
          expect(body.port).toBe(5439);
          expect(body.database).toBe("dev");
          // WithIAM maps the caller's IAM identity to a database user
          // prefixed with `IAM:`/`IAMR:`.
          expect(body.username).toMatch(/^IAM/);
          expect(body.hasPassword).toBe(true);
          expect(body.ssl).toBe(true);
          expect(body.urlScheme).toBe("postgresql");
          expect(body.expiresInFuture).toBe(true);
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "mints named-user temporary credentials (GetClusterCredentials + AutoCreate)",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* getInfo("/info-dbuser");
          expect(body.port).toBe(5439);
          // AutoCreate=true prefixes the user with `IAMA:`.
          expect(body.username).toBe("IAMA:alchemy_etl");
          expect(body.hasPassword).toBe(true);
          expect(body.urlScheme).toBe("postgresql");
          expect(body.expiresInFuture).toBe(true);
        }),
      { timeout: 240_000 },
    );
  });
});
