import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import DocumentAIBindingsHost, {
  Invoice,
  InvoiceV1,
  OcrBind,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DocumentAIBindings");

let baseUrl: string;
let hostAccount: string;
let processorName: string;
let schemaName: string;
let versionName: string;

/**
 * Document AI has no resource-level IAM, so its bindings grant on the
 * project: `documentai.viewer` (GetProcessor / GetSchema / GetSchemaVersion)
 * and `documentai.apiUser` (Process).
 */
const expectProjectGrants = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
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
    { role: "roles/documentai.apiUser", condition: undefined },
    { role: "roles/documentai.viewer", condition: undefined },
  ]);
});

describe.skipIf(!dockerAvailable || !!process.env.FAST)(
  "DocumentAI Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:documentai",
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
            const host = yield* DocumentAIBindingsHost;
            const processor = yield* OcrBind;
            const schema = yield* Invoice;
            const version = yield* InvoiceV1;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              processor: processor.name,
              schema: schema.name,
              version: version.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        processorName = out.processor;
        schemaName = out.schema;
        versionName = out.version;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetProcessor", () => {
      test.provider(
        "reads the processor as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const processor =
              yield* expectProbe<documentai.GoogleCloudDocumentaiV1Processor>(
                baseUrl,
                "getProcessor",
              );
            const live = yield* documentai.getProjectsLocationsProcessors({
              name: processorName,
            });
            expect(processor.name).toEqual(processorName);
            expect(processor.type).toEqual("OCR_PROCESSOR");
            expect(processor.displayName).toEqual(live.displayName);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:documentai", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("Process", () => {
      test.provider(
        "OCRs a PDF as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const processed = yield* expectProbe<{
              text?: string;
              pages?: number;
            }>(baseUrl, "process");
            expect(processed.pages).toEqual(1);
            expect(processed.text).toContain("Hello");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:documentai", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetSchema", () => {
      test.provider(
        "reads the schema as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const schema =
              yield* expectProbe<documentai.GoogleCloudDocumentaiV1NextSchema>(
                baseUrl,
                "getSchema",
              );
            const live = yield* documentai.getProjectsLocationsSchemas({
              name: schemaName,
            });
            expect(schema.name).toEqual(schemaName);
            expect(schema.displayName).toEqual("invoice-bind");
            expect(schema.labels).toEqual(live.labels);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:documentai", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetSchemaVersion", () => {
      test.provider(
        "reads the schema version as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const version =
              yield* expectProbe<documentai.GoogleCloudDocumentaiV1SchemaVersion>(
                baseUrl,
                "getSchemaVersion",
              );
            const live =
              yield* documentai.getProjectsLocationsSchemasSchemaVersions({
                name: versionName,
              });
            expect(version.name).toEqual(versionName);
            expect(version.displayName).toEqual("v1");
            expect(
              version.schema?.entityTypes?.[0]?.properties?.map(
                (property) => property.name,
              ),
            ).toEqual(
              live.schema?.entityTypes?.[0]?.properties?.map(
                (property) => property.name,
              ),
            );
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:documentai", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
