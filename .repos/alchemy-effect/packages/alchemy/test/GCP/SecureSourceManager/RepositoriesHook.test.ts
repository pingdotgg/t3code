import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as ssm from "@distilled.cloud/gcp/securesourcemanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  currentProject,
  logLevel,
  missingRepoOf,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  ssm.getProjectsLocationsRepositoriesHooks({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsRepositoriesHooks on a missing hook fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const missingRepo = missingRepoOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        ssm.getProjectsLocationsRepositoriesHooks({
          name: `${missingRepo}/hooks/alchemy-missing-hook`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securesourcemanager", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create against a missing repository is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const missingRepo = missingRepoOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.SecureSourceManager.RepositoriesHook("Notify", {
              repository: missingRepo,
              targetUri: "https://example.com/hooks/ssm",
              events: ["PUSH"],
            });
          }),
        ),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securesourcemanager", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a hook",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const missingRepo = missingRepoOf(project);
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecureSourceManager.RepositoriesHook("Notify", {
            repository:
              process.env.GCP_TEST_SECURE_SOURCE_MANAGER_REPO ?? missingRepo,
            targetUri: "https://example.com/hooks/ssm",
            events: ["PUSH"],
          });
        }),
      );

      expect(created.name).toContain("/hooks/");
      expect(created.targetUri).toEqual("https://example.com/hooks/ssm");
      expect(created.events).toContain("PUSH");
      expect(created.disabled).toEqual(false);

      const fetched = yield* ssm.getProjectsLocationsRepositoriesHooks({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.targetUri).toEqual("https://example.com/hooks/ssm");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecureSourceManager.RepositoriesHook("Notify", {
            repository: created.repository,
            hookId: created.hookId,
            targetUri: "https://example.com/hooks/ssm-v2",
            events: ["PUSH", "PULL_REQUEST"],
            disabled: true,
          });
        }),
      );

      expect(updated.hookId).toEqual(created.hookId);
      expect(updated.targetUri).toEqual("https://example.com/hooks/ssm-v2");
      expect(updated.disabled).toEqual(true);
      expect(updated.events).toEqual(["PULL_REQUEST", "PUSH"]);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securesourcemanager", "live"],
    timeout: 120_000,
  },
);
