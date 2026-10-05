import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
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
  resourcemanager.getLiens({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getLiens on a missing lien fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      // Lien names are `liens/p{projectNumber}-l{uuid}`.
      const resource = yield* resourcemanager.getProjects({
        name: `projects/${project}`,
      });
      const projectNumber = (resource.name ?? "").split("/").pop();
      const error = yield* Effect.flip(
        resourcemanager.getLiens({
          name: `liens/p${projectNumber}-l00000000-0000-0000-0000-000000000000`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:resourcemanager", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, replace, and delete a lien",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.Lien("Hold", {
            reason: "production API key",
          });
        }),
      );

      expect(created.name).toMatch(/^liens\//);
      expect(created.parent).toContain("projects/");
      expect(created.origin).toEqual("alchemy.effect");
      expect(created.reason).toEqual("production API key");
      expect(created.restrictions).toContain("resourcemanager.projects.delete");

      const fetched = yield* resourcemanager.getLiens({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.reason).toEqual("production API key");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.Lien("Hold", {
            parent: created.parent,
            origin: created.origin,
            reason: "holds billing export",
            restrictions: created.restrictions,
          });
        }),
      );

      expect(replaced.name).not.toEqual(created.name);
      expect(replaced.reason).toEqual("holds billing export");
      expect(replaced.parent).toEqual(created.parent);

      const fetchedReplace = yield* resourcemanager.getLiens({
        name: replaced.name,
      });
      expect(fetchedReplace.reason).toEqual("holds billing export");

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
