import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
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
  crm.getTagValues({ name }).pipe(
    Effect.as("found" as const),
    // A deleted TagValue answers 403 "... (or it may not exist)".
    Effect.catchTag("TagValueNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const nextShortName = (name: string) =>
  name.length < 256 ? `${name}x` : `${name.slice(0, 255)}x`;

test.provider(
  "getTagValues on a missing value fails with TagValueNotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        crm.getTagValues({
          name: "tagValues/999999999999",
        }),
      );
      expect(error._tag).toEqual("TagValueNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:resourcemanager", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, replace, and delete a tag value",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* GCP.ResourceManager.TagKey("EnvKey", {
            description: "tag value parent",
          });
          const value = yield* GCP.ResourceManager.TagValue("Env", {
            parent: key.name,
            description: "production",
          });
          return { key, value };
        }),
      );

      expect(created.value.name).toEqual(expect.stringMatching(/^tagValues\//));
      expect(created.value.parent).toEqual(created.key.name);
      expect(created.value.shortName).toEqual(expect.any(String));
      expect(created.value.description).toEqual("production");
      expect(created.value.project).toEqual(project);
      expect(created.value.namespacedName).toContain(created.value.shortName);

      const fetched = yield* crm.getTagValues({ name: created.value.name });
      expect(fetched.name).toEqual(created.value.name);
      expect(fetched.shortName).toEqual(created.value.shortName);
      expect(fetched.parent).toEqual(created.key.name);
      expect(fetched.description).toEqual("production");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* GCP.ResourceManager.TagKey("EnvKey", {
            shortName: created.key.shortName,
            description: "tag value parent",
          });
          return yield* GCP.ResourceManager.TagValue("Env", {
            parent: key.name,
            shortName: created.value.shortName,
            description: "production workloads",
          });
        }),
      );

      expect(updated.name).toEqual(created.value.name);
      expect(updated.shortName).toEqual(created.value.shortName);
      expect(updated.description).toEqual("production workloads");

      const fetchedUpdate = yield* crm.getTagValues({
        name: created.value.name,
      });
      expect(fetchedUpdate.description).toEqual("production workloads");

      const replacedShortName = nextShortName(created.value.shortName);
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* GCP.ResourceManager.TagKey("EnvKey", {
            shortName: created.key.shortName,
            description: "tag value parent",
          });
          return yield* GCP.ResourceManager.TagValue("Env", {
            parent: key.name,
            shortName: replacedShortName,
            description: "replaced value",
          });
        }),
      );

      expect(replaced.shortName).toEqual(replacedShortName);
      expect(replaced.name).not.toEqual(created.value.name);
      expect(replaced.description).toEqual("replaced value");

      const fetchedReplaced = yield* crm.getTagValues({ name: replaced.name });
      expect(fetchedReplaced.shortName).toEqual(replacedShortName);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:resourcemanager", "live"],
    timeout: 90_000,
  },
);
