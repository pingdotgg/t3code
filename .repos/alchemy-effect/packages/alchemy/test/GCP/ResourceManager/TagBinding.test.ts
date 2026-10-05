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

const waitUntilGone = (parent: string, tagValue: string) =>
  resourcemanager
    .listTagBindings({
      parent,
      pageSize: 300,
    })
    .pipe(
      Effect.map((page) =>
        (page.tagBindings ?? []).some(
          (binding) =>
            binding.tagValue === tagValue ||
            binding.tagValueNamespacedName === tagValue,
        )
          ? ("found" as const)
          : ("gone" as const),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "create, replace, and delete a tag binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* GCP.ResourceManager.TagKey("Environment", {
            description: "tagbinding test",
          });
          const valueA = yield* GCP.ResourceManager.TagValue("Test", {
            parent: key.name,
            shortName: "test",
          });
          const valueB = yield* GCP.ResourceManager.TagValue("Prod", {
            parent: key.name,
            shortName: "prod",
          });
          const binding = yield* GCP.ResourceManager.TagBinding("Env", {
            tagValue: valueA.name,
          });
          return { key, valueA, valueB, binding };
        }),
      );

      expect(created.binding.name).toContain("tagBindings/");
      expect(created.binding.tagValue).toEqual(created.valueA.name);
      expect(created.binding.parent).toContain("/projects/");
      expect(created.binding.project).toEqual(expect.any(String));

      const listed = yield* resourcemanager.listTagBindings({
        parent: created.binding.parent,
        pageSize: 300,
      });
      const fetched = (listed.tagBindings ?? []).find(
        (binding) => binding.name === created.binding.name,
      );
      expect(fetched?.tagValue).toEqual(created.valueA.name);
      expect(fetched?.parent).toEqual(created.binding.parent);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* GCP.ResourceManager.TagKey("Environment", {
            shortName: created.key.shortName,
            description: "tagbinding test",
          });
          const valueA = yield* GCP.ResourceManager.TagValue("Test", {
            parent: key.name,
            shortName: created.valueA.shortName,
          });
          const valueB = yield* GCP.ResourceManager.TagValue("Prod", {
            parent: key.name,
            shortName: created.valueB.shortName,
          });
          const binding = yield* GCP.ResourceManager.TagBinding("Env", {
            parent: created.binding.parent,
            tagValue: valueB.name,
          });
          return { key, valueA, valueB, binding };
        }),
      );

      expect(replaced.binding.parent).toEqual(created.binding.parent);
      expect(replaced.binding.tagValue).toEqual(replaced.valueB.name);
      expect(replaced.binding.name).not.toEqual(created.binding.name);

      const previousGone = yield* waitUntilGone(
        created.binding.parent,
        created.valueA.name,
      );
      expect(previousGone).toEqual("gone");

      const listedAfter = yield* resourcemanager.listTagBindings({
        parent: replaced.binding.parent,
        pageSize: 300,
      });
      const fetchedAfter = (listedAfter.tagBindings ?? []).find(
        (binding) => binding.name === replaced.binding.name,
      );
      expect(fetchedAfter?.tagValue).toEqual(replaced.valueB.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        replaced.binding.parent,
        replaced.valueB.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:resourcemanager", "live"],
    timeout: 90_000,
  },
);
