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

// New projects must switch RAG Engine to Serverless mode first; otherwise
// create fails with BadRequest "For new projects, using Spanner mode with
// RAG Engine in us-central1, us-east1, and us-east4 is restricted to only
// allowlisted projects." Set GCP_TEST_AIPLATFORM_RAG=1 once the project's
// RagEngineConfig is Serverless.
const runLifecycle = !process.env.FAST && !!process.env.GCP_TEST_AIPLATFORM_RAG;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsRagCorpora({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsRagCorpora on a missing corpus fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsRagCorpora({
          name: `${parent}/ragCorpora/1234567890123456789`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page = yield* aiplatform.listProjectsLocationsRagCorpora({
        parent,
        pageSize: 10,
      });
      expect((page.ragCorpora ?? []).map((item) => item.name)).not.toContain(
        `${parent}/ragCorpora/1234567890123456789`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsLocationsRagCorpora is rejected until RAG Engine is Serverless",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      const error = yield* Effect.flip(
        aiplatform.createProjectsLocationsRagCorpora({
          parent: `projects/${project}/locations/us-central1`,
          body: { displayName: "alchemy-rag-probe" },
        }),
      );
      expect(error._tag).toEqual("BadRequest");
      expect(String(error.message)).toContain("Spanner mode");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a rag corpus",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.RagCorpora("Docs", {
            location: "us-central1",
            displayName: "product-docs",
            description: "product manuals",
          });
        }),
      );

      expect(created.name).toContain("/ragCorpora/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("product-docs");
      expect(created.description).toEqual("product manuals");

      const fetched = yield* aiplatform.getProjectsLocationsRagCorpora({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.RagCorpora("Docs", {
            location: "us-central1",
            displayName: "product-docs-v2",
            description: "product manuals v2",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("product-docs-v2");
      expect(updated.description).toEqual("product manuals v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 180_000,
  },
);
