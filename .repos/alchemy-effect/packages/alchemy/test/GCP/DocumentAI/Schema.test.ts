import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
const location = "us";

const waitUntilGone = (name: string) =>
  documentai.getProjectsLocationsSchemas({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsSchemas on a missing schema fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/${location}`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        documentai.getProjectsLocationsSchemas({
          name: `${parent}/schemas/alchemy-missing-schema`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:documentai", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a schema",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/${location}`;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DocumentAI.Schema("Invoice", {
            location,
            displayName: "invoice-schema",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.schemaId).toEqual(expect.any(String));
      expect(created.name).toContain("/schemas/");
      expect(created.location).toEqual(location);
      expect(created.displayName).toEqual("invoice-schema");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* documentai.getProjectsLocationsSchemas({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("invoice-schema");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DocumentAI.Schema("Invoice", {
            schemaId: created.schemaId,
            location,
            displayName: "invoice-schema-v2",
            labels: { env: "prod", role: "schema" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("invoice-schema-v2");
      expect(updated.labels).toMatchObject({
        env: "prod",
        role: "schema",
      });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:documentai", "live"],
    timeout: 120_000,
  },
);
