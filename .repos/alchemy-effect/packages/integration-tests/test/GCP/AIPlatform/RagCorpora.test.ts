import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// New projects must switch RAG Engine to Serverless mode first; otherwise
// create fails with BadRequest "For new projects, using Spanner mode with
// RAG Engine in us-central1, us-east1, and us-east4 is restricted to only
// allowlisted projects." The testing project is Serverless now, but updating a
// Serverless corpus fails: v1 GET omits its RAG_MANAGED_VERTEX_VECTOR_SEARCH
// backend and v1 PATCH (no update mask) reads the omission as RAG_MANAGED_DB
// ("The vector db type is immutable"). Set GCP_TEST_AIPLATFORM_RAG=1 to run
// the lifecycle.
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
