import * as GitHub from "@/GitHub";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Output from "@/Output";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

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

const request = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => error as Error & { status?: number },
  });

const branches = ["alchemy-pr-1569-a", "alchemy-pr-1569-b"];

const prepareBranches = Effect.gen(function* () {
  const client = yield* Octokit;
  const scope = { owner, repo };
  const { data: repository } = yield* request(() =>
    client.rest.repos.get(scope),
  );
  const base = repository.default_branch;
  const { data: ref } = yield* request(() =>
    client.rest.git.getRef({ ...scope, ref: `heads/${base}` }),
  );
  for (const branch of branches) {
    const existing = yield* request(() =>
      client.rest.git.getRef({ ...scope, ref: `heads/${branch}` }),
    ).pipe(
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.succeed(undefined),
      ),
    );
    if (existing === undefined) {
      yield* request(() =>
        client.rest.git.createRef({
          ...scope,
          ref: `refs/heads/${branch}`,
          sha: ref.object.sha,
        }),
      );
      yield* request(() =>
        client.rest.repos.createOrUpdateFileContents({
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
  const client = yield* Octokit;
  for (const branch of branches) {
    yield* request(() =>
      client.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` }),
    );
  }
});

test.provider(
  "create, update, replace, and close a pull request",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* stack.deploy(repository());
      const base = yield* prepareBranches;
      const client = yield* Octokit;
      const { data: user } = yield* request(() =>
        client.rest.users.getAuthenticated(),
      );
      const { data: milestone } = yield* request(() =>
        client.rest.issues.createMilestone({
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
      const get = (number: number) =>
        request(() =>
          client.rest.pulls.get({ owner, repo, pull_number: number }),
        );
      const created = yield* deploy({
        body: "\n        Initial body\n      ",
        draft: true,
        labels: ["bug"],
        assignees: [user.login],
        milestone: milestone.number,
      });
      expect(created.prNumber).toBeGreaterThan(0);
      expect(created.htmlUrl).toBe(
        `https://github.com/${owner}/${repo}/pull/${created.prNumber}`,
      );
      expect(created.draft).toBe(true);
      expect(created.merged).toBe(false);
      const initial = (yield* get(created.prNumber)).data;
      expect(initial.body).toBe("Initial body");
      expect(initial.assignees?.map((assignee) => assignee.login)).toEqual([
        user.login,
      ]);
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
      const afterUpdate = (yield* get(created.prNumber)).data;
      expect(afterUpdate.title).toBe("Updated PR");
      expect(afterUpdate.body ?? "").toBe("");
      expect(afterUpdate.draft).toBe(false);
      expect(afterUpdate.assignees).toEqual([]);
      expect(afterUpdate.milestone).toBeNull();
      expect(afterUpdate.labels.map((label) => label.name)).toEqual([
        "enhancement",
      ]);
      expect(afterUpdate.requested_reviewers).toEqual([]);
      expect(afterUpdate.requested_teams).toEqual([]);

      const draft = yield* deploy({ draft: true, labels: [] });
      expect(draft.draft).toBe(true);
      expect((yield* get(draft.prNumber)).data.draft).toBe(true);
      expect((yield* get(draft.prNumber)).data.labels).toEqual([]);
      const closed = yield* deploy({ state: "closed", draft: true });
      expect(closed.state).toBe("closed");
      expect((yield* get(closed.prNumber)).data.state).toBe("closed");
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
      expect((yield* get(created.prNumber)).data.state).toBe("closed");
      expect((yield* get(replaced.prNumber)).data.state).toBe("closed");
      const final = yield* deploy({ head: "alchemy-pr-1569-b" });
      expect(final.prNumber).toBe(replaced.prNumber);
      expect(final.state).toBe("open");

      // Verify closure before releasing the retained repository fixture.
      yield* stack.deploy(repository());
      expect((yield* get(final.prNumber)).data.state).toBe("closed");
      const open = yield* request(() =>
        client.rest.pulls.list({ owner, repo, state: "open" }),
      );
      expect(open.data).toEqual([]);
      yield* deleteBranches;
      yield* request(() =>
        client.rest.issues.deleteMilestone({
          owner,
          repo,
          milestone_number: milestone.number,
        }),
      );
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:github",
      "provider:github:pullrequest",
      "provider:github:repository",
      "live",
    ],
    timeout: 120_000,
  },
);
