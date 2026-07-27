import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as mwaa from "@distilled.cloud/aws/mwaa";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import MWAATestFunctionLive, { MWAATestFunction } from "./bindings-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test } = Test.make(testOptions);

// A well-formed-but-nonexistent environment name the ungated probes are
// driven against.
const NONEXISTENT_ENVIRONMENT = "alchemy-mwaa-nonexistent-probe";

// ---------------------------------------------------------------------------
// Ungated typed-error probes: every data-plane operation the four bindings
// wrap is exercised directly through distilled against a nonexistent
// environment, and must answer with the typed not-found tag. These prove the
// distilled error unions (and request serialization) at near-zero cost on
// every CI pass, while the full runtime fixture below is gated behind the
// 20-30 minute environment provisioning.
// ---------------------------------------------------------------------------

describe("MWAA data-plane operations (typed-error probes)", () => {
  test.provider(
    "createCliToken on a nonexistent environment fails with ResourceNotFoundException",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          mwaa.createCliToken({ Name: NONEXISTENT_ENVIRONMENT }),
        );
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
  );

  test.provider(
    "createWebLoginToken on a nonexistent environment fails with ResourceNotFoundException",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          mwaa.createWebLoginToken({ Name: NONEXISTENT_ENVIRONMENT }),
        );
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
  );

  test.provider(
    "invokeRestApi on a nonexistent environment fails with ResourceNotFoundException",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          mwaa.invokeRestApi({
            Name: NONEXISTENT_ENVIRONMENT,
            Method: "GET",
            Path: "/dags",
          }),
        );
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
  );
});

// ---------------------------------------------------------------------------
// Full runtime fixture: a Lambda bound to all four MWAA bindings against a
// live Airflow environment. An environment takes ~20-30 minutes to provision
// and is billed hourly while it exists (and needs real private-subnet
// networking supplied out of band), so this is gated behind AWS_TEST_SLOW=1
// (same gate as the Environment lifecycle test) and always destroys what it
// created.
// ---------------------------------------------------------------------------

const sharedStack = Core.scratchStack(testOptions, "MWAABindings");

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "token, REST API, and describe bindings against a live environment",
  () =>
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      yield* Effect.gen(function* () {
        const { functionUrl } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return yield* MWAATestFunction;
          }).pipe(Effect.provide(MWAATestFunctionLive)),
        );
        expect(functionUrl).toBeTruthy();
        const baseUrl = functionUrl!.replace(/\/+$/, "");

        const getJson = (path: string) =>
          HttpClient.get(`${baseUrl}${path}`).pipe(
            Effect.flatMap((response) =>
              response.status >= 500
                ? Effect.fail(
                    new Error(`transient upstream ${response.status}`),
                  )
                : Effect.succeed(response),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("500 millis"),
                Schedule.recurs(10),
              ]),
            }),
            Effect.flatMap((r) => r.json),
          );

        // All four capabilities initialized in the runtime.
        const bindings = (yield* getJson("/bindings")) as { bound: string[] };
        expect(bindings.bound).toHaveLength(4);

        // GetEnvironment — proves the environment-ARN grant + Name injection.
        const env = (yield* getJson("/environment")) as {
          status?: string;
          errorTag?: string;
        };
        expect(env.errorTag).toBeUndefined();
        expect(env.status).toBe("AVAILABLE");

        // CreateCliToken — 60-second Airflow CLI token.
        const cli = (yield* getJson("/cli-token")) as {
          hasToken?: boolean;
          hostname?: string;
          errorTag?: string;
        };
        expect(cli.errorTag).toBeUndefined();
        expect(cli.hasToken).toBe(true);
        expect(cli.hostname).toBeTruthy();

        // CreateWebLoginToken — proves the Airflow-role-ARN grant (Admin).
        const web = (yield* getJson("/web-login-token")) as {
          hasToken?: boolean;
          hostname?: string;
          errorTag?: string;
        };
        expect(web.errorTag).toBeUndefined();
        expect(web.hasToken).toBe(true);
        expect(web.hostname).toBeTruthy();

        // InvokeRestApi — GET /dags through the Airflow REST API.
        const dags = (yield* getJson("/dags")) as {
          statusCode?: number;
          errorTag?: string;
        };
        expect(dags.errorTag).toBeUndefined();
        expect(dags.statusCode).toBe(200);
      }).pipe(Effect.ensuring(sharedStack.destroy().pipe(Effect.orDie)));
    }),
  // environment create (~20-30 min) + binding checks + destroy initiation.
  { timeout: 5_400_000 },
);
