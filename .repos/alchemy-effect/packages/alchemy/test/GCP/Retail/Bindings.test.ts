import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import type * as retail from "@distilled.cloud/gcp/retail_v2";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import RetailBindingsHost, {
  retailEnabled,
  Serving,
  Shirt,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RetailBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;

/** Serving configs have no IAM policy: both bindings grant on the project. */
const expectProjectGrants = Effect.gen(function* () {
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  const roles = (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => ({ role: binding.role, condition: binding.condition }));
  expect(roles).toEqual([
    { role: "roles/retail.viewer", condition: undefined },
  ]);
});

describe.skipIf(!dockerAvailable || !retailEnabled)(
  "Retail Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:retail", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* RetailBindingsHost;
            const serving = yield* Serving;
            yield* Shirt;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              project: serving.project,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("Search", () => {
      test.provider(
        "searches the catalog as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const searched =
              yield* expectProbe<retail.GoogleCloudRetailV2SearchResponse>(
                baseUrl,
                "search",
              );
            expect(searched.attributionToken).toEqual(expect.any(String));
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:retail", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("Predict", () => {
      test.provider(
        "validates a prediction request as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const predicted =
              yield* expectProbe<retail.GoogleCloudRetailV2PredictResponse>(
                baseUrl,
                "predict",
              );
            expect(predicted.validateOnly).toEqual(true);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:retail", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
