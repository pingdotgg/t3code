import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
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

const waitUntilGone = (name: string) =>
  dataproc.getProjectsLocationsSessionTemplates({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsSessionTemplates on a missing template fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataproc.getProjectsLocationsSessionTemplates({
          name: `projects/${project}/locations/us-central1/sessionTemplates/alchemy-dataproc-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataproc", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a session template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataproc.SessionTemplate("Notebook", {
            location: "us-central1",
            description: "template a",
            jupyterSession: { kernel: "PYTHON" },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/sessionTemplates/");
      expect(created.templateId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("template a");
      expect(created.jupyterKernel).toEqual("PYTHON");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* dataproc.getProjectsLocationsSessionTemplates({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("template a");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataproc.SessionTemplate("Notebook", {
            templateId: created.templateId,
            location: "us-central1",
            description: "template b",
            jupyterSession: { kernel: "PYTHON" },
            labels: { env: "prod", role: "nb" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("template b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "nb" });

      const refetched = yield* dataproc.getProjectsLocationsSessionTemplates({
        name: created.name,
      });
      expect(refetched.description).toEqual("template b");
      expect(refetched.labels?.env).toEqual("prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataproc", "live"], timeout: 90_000 },
);
