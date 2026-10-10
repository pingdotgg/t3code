import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as firebaseappcheck from "@distilled.cloud/gcp/firebaseappcheck_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import { currentProject, runLifecycle } from "./common.ts";
import AppCheckBindingsHost, { Local } from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AppCheckBindings");

let baseUrl: string;
let hostAccount: string;
let debugTokenName: string;
let appName: string;

const jwtClaims = (token: string) =>
  JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as { sub?: string; aud?: string[] };

// App Check needs a Firebase project with the App Check API enabled (see
// ./common.ts); set GCP_TEST_FIREBASE_APP_ID to run.
describe.skipIf(!dockerAvailable || !runLifecycle)(
  "FirebaseAppCheck Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:firebaseappcheck",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* AppCheckBindingsHost;
            const debug = yield* Local;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              debugToken: debug.name,
              app: debug.app,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        debugTokenName = out.debugToken;
        appName = out.app;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("ExchangeDebugToken", () => {
      test.provider(
        "mints an App Check token for the app, with no IAM grant",
        (_stack) =>
          Effect.gen(function* () {
            const out =
              yield* expectProbe<firebaseappcheck.GoogleFirebaseAppcheckV1AppCheckToken>(
                baseUrl,
                "exchangeDebugToken",
              );
            expect(out.ttl).toEqual(expect.any(String));
            const claims = jwtClaims(out.token ?? "");
            // `sub` is the app id: the last segment of `projects/p/apps/{id}`.
            expect(claims.sub).toEqual(appName.split("/").pop());

            // The debug token the exchange used is still registered.
            const debug = yield* firebaseappcheck.getProjectsAppsDebugTokens({
              name: debugTokenName,
            });
            expect(debug.displayName).toEqual("alchemy-exchange");

            // exchangeDebugToken is not IAM-gated: the binding grants nothing.
            const project = yield* currentProject;
            const policy = yield* resourcemanager.getIamPolicyProjects({
              resource: `projects/${project}`,
              body: { options: { requestedPolicyVersion: 3 } },
            });
            const roles = (policy.bindings ?? []).filter((binding) =>
              (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
            );
            expect(roles).toEqual([]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firebaseappcheck", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
