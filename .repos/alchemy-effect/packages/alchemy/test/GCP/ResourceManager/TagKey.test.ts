import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
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
  resourcemanager.getTagKeys({ name }).pipe(
    Effect.as("found" as const),
    // A deleted TagKey answers 403 "... (or it may not exist)".
    Effect.catchTag("TagKeyNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a tag key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.TagKey("Environment", {
            description: "deployment environment",
          });
        }),
      );

      expect(created.name).toMatch(/^tagKeys\//);
      expect(created.shortName).toEqual(expect.any(String));
      expect(created.parent).toContain("projects/");
      expect(created.description).toEqual("deployment environment");
      expect(created.namespacedName).toContain(created.shortName);

      const fetched = yield* resourcemanager.getTagKeys({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.shortName).toEqual(created.shortName);
      expect(fetched.description).toEqual("deployment environment");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.TagKey("Environment", {
            shortName: created.shortName,
            description: "prod vs staging",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.shortName).toEqual(created.shortName);
      expect(updated.description).toEqual("prod vs staging");
      expect(updated.createTime).toEqual(created.createTime);

      const fetchedUpdate = yield* resourcemanager.getTagKeys({
        name: updated.name,
      });
      expect(fetchedUpdate.description).toEqual("prod vs staging");

      const last = created.shortName.at(-1) ?? "a";
      const nextShortName = `${created.shortName.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.TagKey("Environment", {
            shortName: nextShortName,
            description: "replaced key",
          });
        }),
      );

      expect(replaced.shortName).toEqual(nextShortName);
      expect(replaced.shortName).not.toEqual(created.shortName);
      expect(replaced.name).not.toEqual(created.name);
      expect(replaced.description).toEqual("replaced key");

      const fetchedReplace = yield* resourcemanager.getTagKeys({
        name: replaced.name,
      });
      expect(fetchedReplace.shortName).toEqual(nextShortName);
      expect(fetchedReplace.description).toEqual("replaced key");

      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:resourcemanager", "live"],
    timeout: 90_000,
  },
);
