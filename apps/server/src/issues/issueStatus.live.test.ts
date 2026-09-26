/**
 * Live suite for Issue status inputs: real `gh` against real GitHub, no fake CLI. Skipped unless
 * `T3CODE_ISSUES_LIVE=1` and `gh` is signed in to github.com.
 *
 *   T3CODE_ISSUES_LIVE=1 vp test run src/issues/issueStatus.live.test.ts
 *
 * The review-mark test creates two disposable orphan branches in toolboxmd/t3code named
 * `test-fixture/29-review-mark-*` and deletes them when done. One holds only a workflow that makes
 * GitHub Actions post an untrusted `review/independent` status on its own commit; the suite posts
 * the trusted one itself.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  issueStatusOf,
  type OrchestrationProjectShell,
  ProjectId,
  ThreadId,
  trustedReviewMark,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as IssueLinks from "../issueLinks/IssueLinks.ts";
import {
  closingReferencesLive,
  insertProject,
  insertPullRequestLink,
  insertThread,
  projectionLayer,
} from "../issueLinks/IssueLinks.testFixtures.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  COMMIT_REVIEW_FIELDS,
  type GitHubReviewCommit,
  REVIEW_MARK_CONTEXT,
  reviewStatusOf,
} from "./gitHubIssues.ts";
import * as IssueService from "./IssueService.ts";

const live = process.env.T3CODE_ISSUES_LIVE === "1";
const REPOSITORY = "toolboxmd/t3code";

const project = (owner: string, name: string): OrchestrationProjectShell => ({
  id: ProjectId.make(`${owner}-${name}`),
  title: `${owner}/${name}`,
  workspaceRoot: process.cwd(),
  repositoryIdentity: {
    canonicalKey: `github.com/${owner}/${name}`,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `https://github.com/${owner}/${name}.git`,
    },
    provider: "github",
    owner,
    name,
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const projectionsLayer = Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
  getProjectShells: () =>
    Effect.succeed([project("toolboxmd", "t3code"), project("toolboxmd", "model-router")]),
} as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]);

const layer = IssueService.layer.pipe(
  Layer.provide(IssueLinks.layer),
  Layer.provide(closingReferencesLive),
  Layer.provideMerge(GitHubCli.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provide(projectionsLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

const CHECKOUT = process.cwd();

/** The real projection and Issue links over an in-memory database with one t3code checkout. */
const linkedLayer = IssueService.layer.pipe(
  Layer.provideMerge(IssueLinks.layer),
  Layer.provideMerge(GitHubCli.layer),
  Layer.provide(closingReferencesLive),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(projectionLayer({ [CHECKOUT]: REPOSITORY })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(Json);
const decodeJson = Schema.decodeUnknownEffect(Json);

const gh = (args: ReadonlyArray<string>, input?: unknown) =>
  Effect.gen(function* () {
    const github = yield* GitHubCli.GitHubCli;
    const output = yield* github.execute({
      cwd: process.cwd(),
      args: input === undefined ? args : [...args, "--input", "-"],
      ...(input === undefined ? {} : { stdin: encodeJson(input) }),
    });
    return output.stdout;
  });

const ghJson = <A>(args: ReadonlyArray<string>, input?: unknown) =>
  gh(args, input).pipe(
    Effect.flatMap(decodeJson),
    Effect.map((value) => value as A),
    Effect.orDie,
  );

/** Open blockers as GitHub lists them one by one, independent of the summary count the list reads. */
const openBlockersOf = (repository: string, number: number) => {
  const [owner, name] = repository.split("/");
  return ghJson<{
    data: { repository: { issue: { blockedBy: { nodes: Array<{ state: string }> } } } };
  }>([
    "api",
    "graphql",
    "-f",
    `query=query { repository(owner: "${owner}", name: "${name}") { issue(number: ${number}) { blockedBy(first: 100) { nodes { state } } } } }`,
  ]).pipe(
    Effect.map(
      (answer) =>
        answer.data.repository.issue.blockedBy.nodes.filter((node) => node.state === "OPEN").length,
    ),
  );
};

/** A commit with no parents holding exactly these files, on a new branch. */
const orphanBranch = (branch: string, files: Record<string, string>, message: string) =>
  Effect.gen(function* () {
    const tree = yield* ghJson<{ sha: string }>(
      ["api", "-X", "POST", `repos/${REPOSITORY}/git/trees`],
      {
        tree: Object.entries(files).map(([path, content]) => ({
          path,
          mode: "100644",
          type: "blob",
          content,
        })),
      },
    );
    const commit = yield* ghJson<{ sha: string }>(
      ["api", "-X", "POST", `repos/${REPOSITORY}/git/commits`],
      { message, tree: tree.sha, parents: [] },
    );
    yield* gh(["api", "-X", "POST", `repos/${REPOSITORY}/git/refs`], {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
    return commit.sha;
  });

/** The review fields the Issues list reads for a pull request head, for one commit. */
const readReviewCommit = (sha: string) => {
  const [owner, name] = REPOSITORY.split("/");
  return ghJson<{
    data: { viewer: { login: string }; repository: { object: GitHubReviewCommit } };
  }>([
    "api",
    "graphql",
    "-f",
    `query=query { viewer { login } repository(owner: "${owner}", name: "${name}") { object(oid: "${sha}") { ... on Commit { ${COMMIT_REVIEW_FIELDS} } } } }`,
  ]).pipe(
    Effect.map((answer) => ({
      viewer: answer.data.viewer.login,
      commit: answer.data.repository.object,
    })),
  );
};

const UNTRUSTED_WORKFLOW = `name: test-fixture review mark (toolboxmd/t3code#29)
on: push
permissions:
  statuses: write
jobs:
  mark:
    runs-on: ubuntu-latest
    steps:
      - run: >-
          gh api "repos/\${{ github.repository }}/statuses/\${{ github.sha }}"
          -f state=failure -f context=${REVIEW_MARK_CONTEXT}
          -f description="Untrusted test fixture for toolboxmd/t3code#29"
        env:
          GH_TOKEN: \${{ github.token }}
`;

describe.skipIf(!live)("Issue status inputs (live GitHub)", () => {
  it.layer(layer, { timeout: 120_000 })("list page", (it) => {
    it.effect("reads closing pull requests with their head in the list page", () =>
      Effect.gen(function* () {
        const issues = yield* IssueService.IssueService;
        const result = yield* issues.list({
          state: "all",
          sort: "number",
          repositories: ["github.com toolboxmd/t3code"],
          limit: 100,
        });
        expect(result.errors).toEqual([]);
        // PR #35 closed #26 and was merged from feat/26-prism-settings-layout.
        const closed = result.entries.find((entry) => entry.number === 26);
        expect(closed?.closingPullRequests).toContainEqual({
          host: "github.com",
          repository: "toolboxmd/t3code",
          number: 35,
          url: "https://github.com/toolboxmd/t3code/pull/35",
          state: "merged",
          isDraft: false,
          headRefName: "feat/26-prism-settings-layout",
          headSha: "f092bd5b831d0173447dfde5dbc516f1e791d2a3",
          review: null,
        });
        // The side panel's own read carries the same closing pull requests.
        const detail = yield* issues.detail({
          host: "github.com",
          repository: REPOSITORY,
          number: 26,
        });
        expect(detail.closingPullRequests.map((pr) => [pr.number, pr.state])).toContainEqual([
          35,
          "merged",
        ]);
        // #29 is natively blocked by #27, #28 and #31.
        const blocked = result.entries.find((entry) => entry.number === 29);
        expect(blocked?.openBlockerCount).toBe(yield* openBlockersOf(REPOSITORY, 29));
      }),
    );

    it.effect("counts only open blockers", () =>
      Effect.gen(function* () {
        const issues = yield* IssueService.IssueService;
        // Blocked by twelve Issues, all closed now.
        const result = yield* issues.list({
          state: "all",
          repositories: ["github.com toolboxmd/model-router"],
          query: "Release, install, final bounded task",
          limit: 20,
        });
        const entry = result.entries.find((candidate) => candidate.number === 17);
        expect(entry).toBeDefined();
        expect(entry!.openBlockerCount).toBe(0);
        expect(yield* openBlockersOf("toolboxmd/model-router", 17)).toBe(0);
      }),
    );
  });

  it.layer(linkedLayer, { timeout: 120_000 })("thread-linked pull requests", (it) => {
    it.effect("a thread's PR into a non-default branch drives the Issue's status", () =>
      Effect.gen(function* () {
        // PR #36 (this work) targets feat/25-issues, so GitHub makes no closing reference for #29.
        const probe = yield* ghJson<{
          state: string;
          isDraft: boolean;
          headRefOid: string;
          baseRefName: string;
        }>([
          "pr",
          "view",
          "36",
          "--repo",
          REPOSITORY,
          "--json",
          "state,isDraft,headRefOid,baseRefName",
        ]);
        expect(probe.baseRefName).not.toBe("main");

        const thread = ThreadId.make("thread-issue-29");
        yield* insertProject("project-t3code", CHECKOUT);
        yield* insertThread({ id: thread, projectId: "project-t3code" });
        yield* insertPullRequestLink({ threadId: thread, repository: REPOSITORY, number: 36 });
        const links = yield* IssueLinks.IssueLinks;
        yield* links.link({
          threadId: thread,
          target: { url: "https://github.com/toolboxmd/t3code/issues/29" },
          source: "manual",
        });

        const issues = yield* IssueService.IssueService;
        const result = yield* issues.list({
          state: "all",
          sort: "number",
          repositories: ["github.com toolboxmd/t3code"],
          limit: 100,
        });
        const issue = result.entries.find((entry) => entry.number === 29)!;
        expect(issue.closingPullRequests.map((pr) => pr.number)).not.toContain(36);
        const linked = result.linkedPullRequests.find((pr) => pr.number === 36);
        // Read with GitHub's real state whatever the thread last synced; merged since counts too.
        expect(linked).toMatchObject({
          host: "github.com",
          repository: REPOSITORY,
          state: probe.state.toLowerCase(),
          isDraft: probe.isDraft,
          headSha: probe.headRefOid,
        });

        const [forIssue] = yield* links.threadsForIssues({
          issues: [
            { host: "github.com", repository: REPOSITORY, number: 29, closingPullRequests: [] },
          ],
        });
        expect(forIssue!.threads).toMatchObject([
          {
            id: thread,
            pullRequests: [{ host: "github.com", repository: REPOSITORY, number: 36 }],
          },
        ]);

        const trusted = new Set(result.viewers.map((viewer) => viewer.login.toLowerCase()));
        const base = {
          state: issue.state,
          openBlockerCount: issue.openBlockerCount,
          hasTaskBranch: false,
          linkedThreadCount: 1,
          workingNow: false,
        };
        const withPullRequest = issueStatusOf({
          ...base,
          pullRequests: [{ ...linked!, reviewMark: trustedReviewMark(linked!.review, trusted) }],
        });
        if (probe.state === "OPEN") {
          expect([
            "in-review",
            "waiting-for-merge",
            "changes-requested",
            "waiting-for-review",
            "paused",
          ]).toContain(withPullRequest);
          expect(issueStatusOf({ ...base, pullRequests: [] })).not.toBe(withPullRequest);
        } else {
          // A merged or closed component PR no longer drives the open Issue's status.
          expect(issueStatusOf({ ...base, pullRequests: [] })).toBe(withPullRequest);
        }

        // A repository filter this server has no project in: no search runs, but the thread's
        // pull request and the viewer are still read for Issues other servers list.
        const filtered = yield* issues.list({
          state: "all",
          repositories: ["github.com toolboxmd/model-router"],
        });
        expect(filtered.entries).toEqual([]);
        expect(filtered.viewers.map((viewer) => viewer.host)).toEqual(["github.com"]);
        expect(filtered.linkedPullRequests.map((pr) => pr.number)).toContain(36);
      }),
    );
  });

  describe("review marks on real commits", () => {
    // Live clock: the wait for GitHub Actions is real time.
    it.live(
      "counts a mark from the connection's account and ignores anyone else's",
      () => {
        const created: Array<string> = [];
        return Effect.gen(function* () {
          const stamp = DateTime.toEpochMillis(yield* DateTime.now);
          const trustedBranch = `test-fixture/29-review-mark-trusted-${stamp}`;
          const untrustedBranch = `test-fixture/29-review-mark-untrusted-${stamp}`;

          const trustedSha = yield* orphanBranch(
            trustedBranch,
            { "README.md": "Disposable test fixture for toolboxmd/t3code#29.\n" },
            "test-fixture: trusted review mark (toolboxmd/t3code#29)",
          );
          created.push(trustedBranch);
          yield* gh(["api", "-X", "POST", `repos/${REPOSITORY}/statuses/${trustedSha}`], {
            state: "success",
            context: REVIEW_MARK_CONTEXT,
            description: "Trusted test fixture for toolboxmd/t3code#29",
          });

          const untrustedSha = yield* orphanBranch(
            untrustedBranch,
            { ".github/workflows/test-fixture-review-mark.yml": UNTRUSTED_WORKFLOW },
            "test-fixture: untrusted review mark (toolboxmd/t3code#29)",
          );
          created.push(untrustedBranch);

          const trusted = yield* readReviewCommit(trustedSha);
          expect(trusted.commit.status?.context?.creator?.login).toBe(trusted.viewer);
          const trustedLogins = new Set([trusted.viewer.toLowerCase()]);
          expect(trustedReviewMark(reviewStatusOf(trusted.commit), trustedLogins)).toBe("success");

          // GitHub Actions posts the untrusted mark once its run starts; nothing else can signal it.
          let untrusted = yield* readReviewCommit(untrustedSha);
          for (let attempt = 0; attempt < 36 && !untrusted.commit.status?.context; attempt += 1) {
            yield* Effect.sleep("5 seconds");
            untrusted = yield* readReviewCommit(untrustedSha);
          }
          const context = untrusted.commit.status?.context;
          expect(context?.state).toBe("FAILURE");
          expect(context?.creator?.login).toBeTruthy();
          expect(context?.creator?.login).not.toBe(untrusted.viewer);
          expect(trustedReviewMark(reviewStatusOf(untrusted.commit), trustedLogins)).toBeNull();
          // The same status counts once its poster is trusted too, e.g. as another server's account.
          const withPoster = new Set([...trustedLogins, context!.creator!.login.toLowerCase()]);
          expect(trustedReviewMark(reviewStatusOf(untrusted.commit), withPoster)).toBe("failure");
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              Effect.forEach(created, (branch) =>
                gh(["api", "-X", "DELETE", `repos/${REPOSITORY}/git/refs/heads/${branch}`]),
              ),
            ).pipe(Effect.orDie),
          ),
          Effect.provide(layer),
        );
      },
      300_000,
    );
  });
});
