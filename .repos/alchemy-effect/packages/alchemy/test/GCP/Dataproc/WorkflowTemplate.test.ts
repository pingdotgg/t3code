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
  dataproc.getProjectsLocationsWorkflowTemplates({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsWorkflowTemplates on a missing template fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataproc.getProjectsLocationsWorkflowTemplates({
          name: `projects/${project}/locations/us-central1/workflowTemplates/alchemy-dataproc-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataproc", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a workflow template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataproc.WorkflowTemplate("Nightly", {
            location: "us-central1",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/workflowTemplates/");
      expect(created.templateId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.version).toEqual(expect.any(Number));

      const fetched = yield* dataproc.getProjectsLocationsWorkflowTemplates({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect((fetched.jobs ?? []).length).toBeGreaterThan(0);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataproc.WorkflowTemplate("Nightly", {
            templateId: created.templateId,
            location: "us-central1",
            dagTimeout: "3600s",
            labels: { env: "prod", role: "etl" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.dagTimeout).toEqual("3600s");
      expect(updated.labels).toMatchObject({ env: "prod", role: "etl" });

      const refetched = yield* dataproc.getProjectsLocationsWorkflowTemplates({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.dagTimeout).toEqual("3600s");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataproc", "live"], timeout: 90_000 },
);
