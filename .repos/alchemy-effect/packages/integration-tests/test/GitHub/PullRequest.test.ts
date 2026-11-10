import * as GitHub from "@alchemy.run/github";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Git from "@distilled.cloud/github/git";
import * as Issues from "@distilled.cloud/github/issues";
import * as Pulls from "@distilled.cloud/github/pulls";
import * as Repos from "@distilled.cloud/github/repos";
import * as Users from "@distilled.cloud/github/users";
import * as Output from "alchemy/Output";
import { destroy } from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import { gh } from "./scope.ts";

const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
if (owner !== "alchemy-run-test" && owner !== "alchemy-run-test-2") {
  throw new Error(`Unsafe GITHUB_TEST_OWNER: ${owner}`);
}

const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

const repo = "alchemy-pr-1569-pull-request";

const repository = () =>
  GitHub.Repository("Repo", {
    owner,
    name: repo,
    description: "Retained deterministic fixture for alchemy PR #1569",
    visibility: "public",
    autoInit: true,
  });

const repoName = (repository: GitHub.Repository) =>
  Output.map(repository.fullName, (fullName) => fullName.split("/")[1]!);

const branches = ["alchemy-pr-1569-a", "alchemy-pr-1569-b"];

const prepareBranches = Effect.gen(function* () {
  const scope = { owner, repo };
  const repository = yield* gh(Repos.get(scope));
  const base = repository.default_branch;
  const ref = yield* gh(Git.getRef({ ...scope, ref: `heads/${base}` }));
  for (const branch of branches) {
    const existing = yield* gh(Git.getRef({ ...scope, ref: `heads/${branch}` })).pipe(
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
    if (existing === undefined) {
      yield* gh(
        Git.createRef({
          ...scope,
          ref: `refs/heads/${branch}`,
          sha: ref.object.sha,
        }),
      );
      yield* gh(
        Repos.createOrUpdateFileContents({
          ...scope,
          branch,
          path: "alchemy-pr-1569.txt",
          message: "Add deterministic PR test fixture",
          content: "YWxjaGVteSBQUiBmaXh0dXJlCg==",
        }),
      );
    }
  }
  return base;
});

const deleteBranches = Effect.gen(function* () {
  for (const branch of branches) {
    yield* gh(Git.deleteRef({ owner, repo, ref: `heads/${branch}` }));
  }
});

test.provider(
  "create, update, replace, and close a pull request",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* stack.deploy(repository());
      const base = yield* prepareBranches;
      const user = yield* gh(Users.getAuthenticated({}));
      const milestone = yield* gh(
        Issues.createMilestone({
          owner,
          repo,
          title: "alchemy-pr-1569-lifecycle",
        }),
      );
      const deploy = (props: Partial<GitHub.PullRequestProps> = {}) =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* repository();
            return yield* GitHub.PullRequest("PR", {
              owner,
              repository: repoName(repo),
              title: "Alchemy PR #1569 lifecycle",
              head: "alchemy-pr-1569-a",
              base,
              ...props,
            }).pipe(destroy());
          }),
        );
      const get = (number: number) => gh(Pulls.get({ owner, repo, pull_number: number }));
      const created = yield* deploy({
        body: "\n        Initial body\n      ",
        draft: true,
        labels: ["bug"],
        assignees: [user.login],
        milestone: milestone.number,
      });
      expect(created.prNumber).toBeGreaterThan(0);
      expect(created.htmlUrl).toBe(`https://github.com/${owner}/${repo}/pull/${created.prNumber}`);
      expect(created.draft).toBe(true);
      expect(created.merged).toBe(false);
      const initial = yield* get(created.prNumber);
      expect(initial.body).toBe("Initial body");
      expect(initial.assignees?.map((assignee) => assignee.login)).toEqual([user.login]);
      expect(initial.milestone?.number).toBe(milestone.number);
      expect(initial.labels.map((label) => label.name)).toEqual(["bug"]);

      const updated = yield* deploy({
        title: "Updated PR",
        body: "",
        draft: false,
        labels: ["enhancement"],
        assignees: [],
        milestone: null,
        reviewers: [],
        teamReviewers: [],
      });
      expect(updated.prNumber).toBe(created.prNumber);
      expect(updated.nodeId).toBe(created.nodeId);
      expect(updated.draft).toBe(false);
      const afterUpdate = yield* get(created.prNumber);
      expect(afterUpdate.title).toBe("Updated PR");
      expect(afterUpdate.body ?? "").toBe("");
      expect(afterUpdate.draft).toBe(false);
      expect(afterUpdate.assignees).toEqual([]);
      expect(afterUpdate.milestone).toBeNull();
      expect(afterUpdate.labels.map((label) => label.name)).toEqual(["enhancement"]);
      expect(afterUpdate.requested_reviewers).toEqual([]);
      expect(afterUpdate.requested_teams).toEqual([]);

      const draft = yield* deploy({ draft: true, labels: [] });
      expect(draft.draft).toBe(true);
      expect((yield* get(draft.prNumber)).draft).toBe(true);
      expect((yield* get(draft.prNumber)).labels).toEqual([]);
      const closed = yield* deploy({ state: "closed", draft: true });
      expect(closed.state).toBe("closed");
      expect((yield* get(closed.prNumber)).state).toBe("closed");
      const reopened = yield* deploy();
      expect(reopened.prNumber).toBe(created.prNumber);
      expect(reopened.state).toBe("open");
      expect(reopened.draft).toBe(false);

      const replaced = yield* deploy({
        head: "alchemy-pr-1569-b",
        state: "closed",
      });
      expect(replaced.prNumber).not.toBe(created.prNumber);
      expect(replaced.nodeId).not.toBe(created.nodeId);
      expect(replaced.state).toBe("closed");
      expect((yield* get(created.prNumber)).state).toBe("closed");
      expect((yield* get(replaced.prNumber)).state).toBe("closed");
      const final = yield* deploy({ head: "alchemy-pr-1569-b" });
      expect(final.prNumber).toBe(replaced.prNumber);
      expect(final.state).toBe("open");

      // Verify closure before releasing the retained repository fixture.
      yield* stack.deploy(repository());
      expect((yield* get(final.prNumber)).state).toBe("closed");
      const open = yield* gh(Pulls.list({ owner, repo, state: "open" }));
      expect(open).toEqual([]);
      yield* deleteBranches;
      yield* gh(
        Issues.deleteMilestone({
          owner,
          repo,
          milestone_number: milestone.number,
        }),
      );
      yield* stack.destroy();
    }),
  {
    tags: ["provider:github", "provider:github:pullrequest", "provider:github:repository", "live"],
    timeout: 120_000,
  },
);
