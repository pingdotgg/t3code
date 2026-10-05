import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import ContentWarehouseBindingsHost, {
  Checks,
  Note,
  Sales,
  Welcome,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ContentWarehouseBindings");

// Document AI Warehouse is disabled on the testing project: calls fail with
// ServiceDisabled "Document AI Warehouse API has not been used in project ...
// before or it is disabled" (the service also needs per-project
// provisioning). Set GCP_TEST_CONTENTWAREHOUSE=1 on a provisioned project.
const runLifecycle =
  !process.env.FAST && !!process.env.GCP_TEST_CONTENTWAREHOUSE;

let baseUrl: string;
let hostAccount: string;
let schemaName: string;
let documentName: string;
let ruleSetName: string;
let synonymSetName: string;

/**
 * Document AI Warehouse has no per-resource IAM for these types, so every
 * binding grants on the project: `documentSchemaViewer` (GetDocumentSchema),
 * `documentViewer` (GetDocument) and `admin` (GetRuleSet / GetSynonymSet —
 * `ruleSets.get` / `synonymSets.get` exist in no narrower role).
 */
const expectProjectGrants = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  const roles = (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => binding.role)
    .sort();
  expect(roles).toEqual([
    "roles/contentwarehouse.admin",
    "roles/contentwarehouse.documentSchemaViewer",
    "roles/contentwarehouse.documentViewer",
  ]);
});

describe.skipIf(!dockerAvailable || !runLifecycle)(
  "ContentWarehouse Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:contentwarehouse",
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
            const host = yield* ContentWarehouseBindingsHost;
            const schema = yield* Note;
            const document = yield* Welcome;
            const rules = yield* Checks;
            const synonyms = yield* Sales;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              schema: schema.name,
              document: document.name,
              rules: rules.name,
              synonyms: synonyms.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        schemaName = out.schema;
        documentName = out.document;
        ruleSetName = out.rules;
        synonymSetName = out.synonyms;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetDocumentSchema", () => {
      test.provider(
        "reads the schema as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const schema =
              yield* expectProbe<cw.GoogleCloudContentwarehouseV1DocumentSchema>(
                baseUrl,
                "getDocumentSchema",
              );
            const live = yield* cw.getProjectsLocationsDocumentSchemas({
              name: schemaName,
            });
            expect(schema.name).toEqual(schemaName);
            expect(schema.displayName).toEqual("binding-note");
            expect(schema.updateTime).toEqual(live.updateTime);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:contentwarehouse", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetDocument", () => {
      test.provider(
        "reads the document as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const document =
              yield* expectProbe<cw.GoogleCloudContentwarehouseV1Document>(
                baseUrl,
                "getDocument",
              );
            expect(document.name).toEqual(documentName);
            expect(document.displayName).toEqual("binding-welcome");
            expect(document.plainText).toEqual("hello binding");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:contentwarehouse", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetRuleSet", () => {
      test.provider(
        "reads the rule set as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const rules =
              yield* expectProbe<cw.GoogleCloudContentwarehouseV1RuleSet>(
                baseUrl,
                "getRuleSet",
              );
            const live = yield* cw.getProjectsLocationsRuleSets({
              name: ruleSetName,
            });
            expect(rules.name).toEqual(ruleSetName);
            expect(rules.description).toEqual("binding rules");
            expect(rules.rules?.length).toEqual(live.rules?.length);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:contentwarehouse", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetSynonymSet", () => {
      test.provider(
        "reads the synonym set as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const synonyms =
              yield* expectProbe<cw.GoogleCloudContentwarehouseV1SynonymSet>(
                baseUrl,
                "getSynonymSet",
              );
            expect(synonyms.name).toEqual(synonymSetName);
            expect(synonyms.synonyms?.[0]?.words).toEqual([
              "sale",
              "invoice",
              "bill",
            ]);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:contentwarehouse", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
