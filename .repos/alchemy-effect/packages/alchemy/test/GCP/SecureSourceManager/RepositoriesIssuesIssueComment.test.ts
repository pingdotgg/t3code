import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as ssm from "@distilled.cloud/gcp/securesourcemanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  currentProject,
  logLevel,
  missingIssueOf,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  ssm.getProjectsLocationsRepositoriesIssuesIssueComments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsRepositoriesIssuesIssueComments on a missing comment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const missingIssue = missingIssueOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        ssm.getProjectsLocationsRepositoriesIssuesIssueComments({
          name: `${missingIssue}/issueComments/12345`,
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
  "create against a missing issue is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const missingIssue = missingIssueOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.SecureSourceManager.RepositoriesIssuesIssueComment(
              "Note",
              {
                issue: missingIssue,
                body: "reproduced on main",
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
  "create, update, and delete an issue comment",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const missingIssue = missingIssueOf(project);
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const issue = yield* GCP.SecureSourceManager.RepositoriesIssue(
            "Bug",
            {
              repository:
                process.env.GCP_TEST_SECURE_SOURCE_MANAGER_REPO ??
                missingIssue.split("/issues/")[0]!,
              title: "comment parent",
              body: "parent issue",
            },
          );
          const comment =
            yield* GCP.SecureSourceManager.RepositoriesIssuesIssueComment(
              "Note",
              {
                issue: issue.name,
                body: "reproduced on main",
              },
            );
          return { issue, comment };
        }),
      );

      expect(created.comment.name).toContain("/issueComments/");
      expect(created.comment.body).toEqual("reproduced on main");
      expect(created.comment.issue).toEqual(created.issue.name);

      const fetched =
        yield* ssm.getProjectsLocationsRepositoriesIssuesIssueComments({
          name: created.comment.name,
        });
      expect(fetched.name).toEqual(created.comment.name);
      expect(fetched.body).toEqual("reproduced on main");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const issue = yield* GCP.SecureSourceManager.RepositoriesIssue(
            "Bug",
            {
              repository: created.issue.repository,
              issueId: created.issue.issueId,
              title: "comment parent",
              body: "parent issue",
            },
          );
          const comment =
            yield* GCP.SecureSourceManager.RepositoriesIssuesIssueComment(
              "Note",
              {
                issue: issue.name,
                commentId: created.comment.commentId,
                body: "reproduced on release",
              },
            );
          return { issue, comment };
        }),
      );

      expect(updated.comment.commentId).toEqual(created.comment.commentId);
      expect(updated.comment.body).toEqual("reproduced on release");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.comment.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securesourcemanager", "live"],
    timeout: 120_000,
  },
);
