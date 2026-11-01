import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import type * as recommendationengine from "@distilled.cloud/gcp/recommendationengine_v1beta1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import { currentProject, entitled } from "./common.ts";
import RecommendationEngineBindingsHost, {
  Shirt,
  TITLE,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "RecommendationEngineBindings",
);

let baseUrl: string;
let member: string;
let itemId: string;

// Recommendations AI (Beta) is not enabled in the testing project; see
// common.ts (GCP_TEST_RECOMMENDATION_ENGINE=1).
describe.skipIf(!dockerAvailable || !entitled || !!process.env.FAST)(
  "RecommendationEngine Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:recommendationengine",
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
            const host = yield* RecommendationEngineBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              itemId: (yield* Shirt).catalogItemId,
            };
          }),
        );
        baseUrl = out.uri!;
        member = `serviceAccount:${out.serviceAccount!}`;
        itemId = out.itemId;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetCatalogItem", () => {
      test.provider(
        "reads the catalog item, granted viewer on the project",
        (_stack) =>
          Effect.gen(function* () {
            const live =
              yield* expectProbe<recommendationengine.GoogleCloudRecommendationengineV1beta1CatalogItem>(
                baseUrl,
                "getCatalogItem",
              );
            expect(live.id).toEqual(itemId);
            expect(live.title).toEqual(TITLE);

            // Recommendations AI has no resource-level IAM or IAM
            // Conditions, so the viewer role is granted on the project.
            const project = yield* currentProject;
            const policy = yield* resourcemanager.getIamPolicyProjects({
              resource: `projects/${project}`,
              body: { options: { requestedPolicyVersion: 3 } },
            });
            expect(
              (policy.bindings ?? [])
                .filter((binding) => (binding.members ?? []).includes(member))
                .map((binding) => [binding.role, binding.condition]),
            ).toEqual([["roles/automlrecommendations.viewer", undefined]]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:recommendationengine", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
