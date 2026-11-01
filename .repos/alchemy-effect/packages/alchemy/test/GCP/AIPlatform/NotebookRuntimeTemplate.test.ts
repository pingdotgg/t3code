import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsNotebookRuntimeTemplates({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsNotebookRuntimeTemplates on a missing template fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsNotebookRuntimeTemplates({
          name: `${parent}/notebookRuntimeTemplates/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page =
        yield* aiplatform.listProjectsLocationsNotebookRuntimeTemplates({
          parent,
          pageSize: 10,
        });
      expect(
        (page.notebookRuntimeTemplates ?? []).map((item) => item.name),
      ).not.toContain(`${parent}/notebookRuntimeTemplates/alchemy-missing`);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a notebook runtime template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.NotebookRuntimeTemplate("Runtime", {
            location: "us-central1",
            displayName: "alchemy-colab",
            description: "colab default",
            machineSpec: { machineType: "e2-standard-4" },
            networkSpec: { enableInternetAccess: true },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/notebookRuntimeTemplates/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.description).toEqual("colab default");

      const fetched =
        yield* aiplatform.getProjectsLocationsNotebookRuntimeTemplates({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.NotebookRuntimeTemplate("Runtime", {
            notebookRuntimeTemplateId: created.notebookRuntimeTemplateId,
            location: "us-central1",
            displayName: "alchemy-colab-v2",
            description: "colab default",
            machineSpec: { machineType: "e2-standard-4" },
            networkSpec: { enableInternetAccess: true },
            labels: { env: "test" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("alchemy-colab-v2");
      expect(updated.labels).toMatchObject({ env: "test" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 180_000,
  },
);
