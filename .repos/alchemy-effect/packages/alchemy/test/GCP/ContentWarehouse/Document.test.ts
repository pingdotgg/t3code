import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Document AI Warehouse is disabled on the testing project: calls fail with
// ServiceDisabled "Document AI Warehouse API has not been used in project ...
// before or it is disabled" (the service also needs per-project
// provisioning). Set GCP_TEST_CONTENTWAREHOUSE=1 on a provisioned project.
const runLifecycle =
  !process.env.FAST && !!process.env.GCP_TEST_CONTENTWAREHOUSE;

const location = "us";

const waitUntilGone = (name: string) =>
  cw.getProjectsLocationsDocuments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(runLifecycle)(
  "getProjectsLocationsDocuments without Document AI Warehouse enabled fails with ServiceDisabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/${location}`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cw.getProjectsLocationsDocuments({
          name: `${parent}/documents/alchemy-missing-document`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contentwarehouse", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a document",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/${location}`;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const schema = yield* GCP.ContentWarehouse.DocumentSchema("Note", {
            location,
            displayName: "note",
            propertyDefinitions: [
              {
                name: "title",
                isSearchable: true,
                textTypeOptions: {},
              },
            ],
          });
          const document = yield* GCP.ContentWarehouse.Document("Welcome", {
            location,
            documentSchemaName: schema.name,
            displayName: "welcome",
            title: "welcome",
            plainText: "hello warehouse",
          });
          return { schema, document };
        }),
      );

      expect(created.document.name).toContain("/documents/");
      expect(created.document.documentId).toEqual(expect.any(String));
      expect(created.document.displayName).toEqual("welcome");
      expect(created.document.plainText).toEqual("hello warehouse");
      expect(created.document.documentSchemaName).toEqual(created.schema.name);

      const fetched = yield* cw.getProjectsLocationsDocuments({
        name: created.document.name,
      });
      expect(fetched.name).toEqual(created.document.name);
      expect(fetched.displayName).toEqual(created.document.displayName);
      expect(fetched.plainText).toEqual("hello warehouse");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const schema = yield* GCP.ContentWarehouse.DocumentSchema("Note", {
            documentSchemaId: created.schema.documentSchemaId,
            location,
            displayName: "note",
            propertyDefinitions: [
              {
                name: "title",
                isSearchable: true,
                textTypeOptions: {},
              },
            ],
          });
          const document = yield* GCP.ContentWarehouse.Document("Welcome", {
            documentId: created.document.documentId,
            referenceId: created.document.referenceId,
            location,
            documentSchemaName: schema.name,
            displayName: "welcome-v2",
            title: "welcome v2",
            plainText: "hello again",
          });
          return { schema, document };
        }),
      );

      expect(updated.document.name).toEqual(created.document.name);
      expect(updated.document.displayName).toEqual("welcome-v2");
      expect(updated.document.plainText).toEqual("hello again");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.document.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contentwarehouse", "live"],
    timeout: 90_000,
  },
);
