import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ServerlessConnectFunctionLive, {
  ServerlessConnectFunction,
} from "./fixtures/connect-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RedshiftServerlessConnect");

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag the Connect runtime path can surface. Runs in every CI pass
// at near-zero cost.
test.provider(
  "getCredentials on a nonexistent workgroup fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        serverless.getCredentials({
          workgroupName: "alchemy-nonexistent-rsconn-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

let baseUrl: string;

// The full lifecycle deploys a Redshift Serverless namespace + workgroup (a
// real-money RPU floor while it exists, ~2-5 min to provision) plus a Lambda,
// so it is gated behind AWS_TEST_REDSHIFT=1 and destroys everything in
// afterAll.
describe.skipIf(!process.env.AWS_TEST_REDSHIFT)(
  "RedshiftServerless.Connect",
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* Effect.logInfo(
          "RedshiftServerless.Connect setup: destroying previous run",
        );
        yield* sharedStack.destroy();

        yield* Effect.logInfo(
          "RedshiftServerless.Connect setup: deploying fixture",
        );
        const { functionUrl } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return yield* ServerlessConnectFunction;
          }).pipe(Effect.provide(ServerlessConnectFunctionLive)),
        );

        expect(functionUrl).toBeTruthy();
        baseUrl = functionUrl!.replace(/\/+$/, "");
        yield* Effect.logInfo(
          `RedshiftServerless.Connect setup: function URL ready (${functionUrl})`,
        );
      }),
      // namespace (~1 min) + workgroup create (~2-5 min) + Lambda deploy.
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("Connect", () => {
      test.provider(
        "mints temporary credentials and formats a pgwire connection URL",
        (_stack) =>
          Effect.gen(function* () {
            const response = yield* HttpClient.get(`${baseUrl}/info`).pipe(
              Effect.flatMap((res) =>
                res.status === 200
                  ? Effect.succeed(res)
                  : Effect.fail(new Error(`info returned ${res.status}`)),
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
              host: string;
              port: number;
              database: string;
              username: string | undefined;
              hasPassword: boolean;
              ssl: boolean;
              urlScheme: string;
              expiresInFuture: boolean;
            };
            expect(body.host).toContain("redshift-serverless");
            expect(body.port).toBe(5439);
            expect(body.database).toBe("dev");
            // GetCredentials maps the caller's IAM identity to a database
            // user prefixed with `IAM:`/`IAMR:`.
            expect(body.username).toMatch(/^IAM/);
            expect(body.hasPassword).toBe(true);
            expect(body.ssl).toBe(true);
            expect(body.urlScheme).toBe("postgresql");
            expect(body.expiresInFuture).toBe(true);
          }),
        { timeout: 240_000 },
      );
    });
  },
);
