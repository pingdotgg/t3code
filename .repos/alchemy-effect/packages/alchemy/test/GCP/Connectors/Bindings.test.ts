import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as connectors from "@distilled.cloud/gcp/connectors_v2";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import ConnectorsBindingsHost, {
  Account,
  ENTITY_TYPE_PARENT,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ConnectorsBindings");

let baseUrl: string;
let hostAccount: string;
let entityName: string;

// Entities live in an existing Integration Connectors connection; set
// GCP_TEST_CONNECTORS_PARENT to its `…/entityTypes/{type}` to run this.
describe.skipIf(!dockerAvailable || ENTITY_TYPE_PARENT.length === 0)(
  "Connectors Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:connectors",
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
            const host = yield* ConnectorsBindingsHost;
            const entity = yield* Account;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              entity: entity.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        entityName = out.entity;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetEntity", () => {
      test.provider(
        "reads the entity as the host's service account, granted on the project",
        (_stack) =>
          Effect.gen(function* () {
            const entity = yield* expectProbe<connectors.Entity>(
              baseUrl,
              "getEntity",
            );
            const live =
              yield* connectors.getProjectsLocationsConnectionsEntityTypesEntities(
                { name: entityName },
              );
            expect(entity.name).toEqual(entityName);
            expect(entity.fields).toMatchObject({ Name: "Alchemy Binding" });
            expect(entity.fields).toEqual(live.fields);

            // Connectors has no resource-level IAM for entities.
            const { project } = yield* GcpEnvironment.current;
            const policy = yield* crm.getIamPolicyProjects({
              resource: `projects/${project}`,
              body: { options: { requestedPolicyVersion: 3 } },
            });
            const roles = (policy.bindings ?? [])
              .filter((binding) =>
                (binding.members ?? []).includes(
                  `serviceAccount:${hostAccount}`,
                ),
              )
              .map((binding) => binding.role);
            expect(roles).toEqual(["roles/connectors.invoker"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:connectors", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
