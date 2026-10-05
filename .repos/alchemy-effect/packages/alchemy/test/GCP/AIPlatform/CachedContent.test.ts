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
  aiplatform.getProjectsLocationsCachedContents({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsCachedContents on a missing cache fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsCachedContents({
          name: `${parent}/cachedContents/alchemy-aiplatform-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page = yield* aiplatform.listProjectsLocationsCachedContents({
        parent,
        pageSize: 10,
      });
      expect(
        (page.cachedContents ?? []).map((item) => item.name),
      ).not.toContain(`${parent}/cachedContents/alchemy-aiplatform-missing`);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

// Explicit caching needs at least 1024 tokens of content.
const styleGuide = Array.from(
  { length: 400 },
  (_, i) =>
    `Rule ${i + 1}: answer question ${i + 1} in at most ${i + 2} words.`,
).join("\n");

test.provider(
  "create, update, and delete cached content",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      const model = `${parent}/publishers/google/models/gemini-2.5-flash`;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.CachedContent("Style", {
            location: "us-central1",
            model,
            ttl: "3600s",
            displayName: "style-cache",
            contents: [
              {
                role: "user",
                parts: [{ text: styleGuide }],
              },
            ],
          });
        }),
      );

      expect(created.name).toContain("/cachedContents/");
      expect(created.model).toContain("gemini");
      expect(created.displayName).toEqual("style-cache");

      const fetched = yield* aiplatform.getProjectsLocationsCachedContents({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.CachedContent("Style", {
            location: "us-central1",
            model,
            ttl: "7200s",
            displayName: "style-cache",
            contents: [
              {
                role: "user",
                parts: [{ text: styleGuide }],
              },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 300_000,
  },
);
