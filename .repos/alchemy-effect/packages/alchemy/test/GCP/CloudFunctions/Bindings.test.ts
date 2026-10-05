import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import CloudFunctionsBindingsHost from "./fixtures/bindings-host.ts";
import TargetFunction from "./fixtures/target-function.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CloudFunctionsBindings");

let baseUrl: string;
let hostAccount: string;
let functionName: string;
let project: string;

/**
 * 2nd gen functions accept only invoker roles on their own IAM policy, so
 * both bindings grant on the project under an IAM Condition naming only the
 * function: GetFunction `roles/cloudfunctions.viewer`, GenerateDownloadUrl
 * `roles/cloudfunctions.developer` (narrowest role with
 * `functions.sourceCodeGet`).
 */
const expectFunctionGrants = Effect.gen(function* () {
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  const condition = `resource.name == "${functionName}" || resource.name.startsWith("${functionName}/")`;
  const grants = (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => ({
      role: binding.role,
      condition: binding.condition?.expression,
    }))
    .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? ""));
  expect(grants).toEqual([
    { role: "roles/cloudfunctions.developer", condition },
    { role: "roles/cloudfunctions.viewer", condition },
  ]);
});

// The target function's gen2 build takes 2-4 minutes.
describe.skipIf(!dockerAvailable || !!process.env.FAST)(
  "CloudFunctions Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:cloudfunctions",
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
            const host = yield* CloudFunctionsBindingsHost;
            const fn = yield* TargetFunction;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              name: fn.name,
              project: fn.project,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        functionName = out.name;
        project = out.project;
      }),
      { timeout: 1_200_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetFunction", () => {
      test.provider(
        "reads the function as the host's service account, scoped to the function by condition",
        (_stack) =>
          Effect.gen(function* () {
            const live =
              yield* expectProbe<cloudfunctions.Cloudfunctions_Function>(
                baseUrl,
                "getFunction",
              );
            expect(live.name).toEqual(functionName);
            expect(live.state).toEqual("ACTIVE");
            expect(live.buildConfig?.entryPoint).toEqual("handler");
            yield* expectFunctionGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:cloudfunctions", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GenerateDownloadUrl", () => {
      test.provider(
        "signs a source download URL as the host's service account, scoped to the function by condition",
        (_stack) =>
          Effect.gen(function* () {
            const { downloadUrl } =
              yield* expectProbe<cloudfunctions.GenerateDownloadUrlResponse>(
                baseUrl,
                "generateDownloadUrl",
              );
            // The signed URL serves the function's source archive (a zip).
            const response = yield* HttpClient.get(downloadUrl ?? "");
            expect(response.status).toEqual(200);
            const bytes = new Uint8Array(yield* response.arrayBuffer);
            expect(String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0)).toEqual(
              "PK",
            );
            yield* expectFunctionGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:cloudfunctions", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
