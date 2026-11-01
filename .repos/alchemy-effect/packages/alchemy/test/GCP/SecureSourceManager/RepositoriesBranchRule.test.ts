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
  ssm.getProjectsLocationsRepositoriesBranchRules({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsRepositoriesBranchRules on a missing rule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const missingRepo = missingRepoOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        ssm.getProjectsLocationsRepositoriesBranchRules({
          name: `${missingRepo}/branchRules/alchemy-missing-rule`,
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
            return yield* GCP.SecureSourceManager.RepositoriesBranchRule(
              "Main",
              {
                repository: missingRepo,
                includePattern: "main",
                requirePullRequest: true,
              },
            );
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
  "create, update, and delete a branch rule",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const missingRepo = missingRepoOf(project);
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecureSourceManager.RepositoriesBranchRule("Main", {
            repository:
              process.env.GCP_TEST_SECURE_SOURCE_MANAGER_REPO ?? missingRepo,
            includePattern: "main",
            requirePullRequest: true,
            minimumApprovalsCount: 1,
            annotations: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/branchRules/");
      expect(created.includePattern).toEqual("main");
      expect(created.requirePullRequest).toEqual(true);
      expect(created.minimumApprovalsCount).toEqual(1);
      expect(created.annotations).toMatchObject({ env: "test" });

      const fetched = yield* ssm.getProjectsLocationsRepositoriesBranchRules({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.annotations?.env).toEqual("test");
      expect(fetched.annotations?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecureSourceManager.RepositoriesBranchRule("Main", {
            repository: created.repository,
            branchRuleId: created.branchRuleId,
            includePattern: "main",
            requirePullRequest: true,
            minimumApprovalsCount: 2,
            requireCommentsResolved: true,
            annotations: { env: "prod", team: "platform" },
          });
        }),
      );

      expect(updated.branchRuleId).toEqual(created.branchRuleId);
      expect(updated.minimumApprovalsCount).toEqual(2);
      expect(updated.requireCommentsResolved).toEqual(true);
      expect(updated.annotations).toMatchObject({
        env: "prod",
        team: "platform",
      });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securesourcemanager", "live"],
    timeout: 120_000,
  },
);
