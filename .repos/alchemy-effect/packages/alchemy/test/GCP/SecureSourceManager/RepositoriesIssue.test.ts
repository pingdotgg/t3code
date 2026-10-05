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
  ssm.getProjectsLocationsRepositoriesIssues({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsRepositoriesIssues on a missing issue fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const missingRepo = missingRepoOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        ssm.getProjectsLocationsRepositoriesIssues({
          name: `${missingRepo}/issues/12345`,
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
            return yield* GCP.SecureSourceManager.RepositoriesIssue("Bug", {
              repository: missingRepo,
              title: "alchemy probe",
              body: "should not exist",
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
  "create, update, and delete an issue",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const missingRepo = missingRepoOf(project);
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecureSourceManager.RepositoriesIssue("Bug", {
            repository:
              process.env.GCP_TEST_SECURE_SOURCE_MANAGER_REPO ?? missingRepo,
            title: "webhook retries 500s",
            body: "hooks retry forever on 500",
          });
        }),
      );

      expect(created.name).toContain("/issues/");
      expect(created.title).toEqual("webhook retries 500s");
      expect(created.body).toEqual("hooks retry forever on 500");

      const fetched = yield* ssm.getProjectsLocationsRepositoriesIssues({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.body).toEqual("hooks retry forever on 500");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecureSourceManager.RepositoriesIssue("Bug", {
            repository: created.repository,
            issueId: created.issueId,
            title: "webhook retries 5xx",
            body: "cap retries at 8",
          });
        }),
      );

      expect(updated.issueId).toEqual(created.issueId);
      expect(updated.title).toEqual("webhook retries 5xx");
      expect(updated.body).toEqual("cap retries at 8");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securesourcemanager", "live"],
    timeout: 120_000,
  },
);
