/**
 * Live suite: real `gh` against real GitHub, no fake CLI. Skipped unless
 * `T3CODE_ISSUES_LIVE=1` and `gh` is signed in to github.com.
 *
 *   T3CODE_ISSUES_LIVE=1 vp test run src/issues/IssueService.live.test.ts
 *
 * Reads use existing toolboxmd Issues. Comment and close/reopen run only when
 * `T3CODE_ISSUES_LIVE_FIXTURE` names a disposable Issue number in toolboxmd/t3code
 * (labelled `test-fixture`); the suite leaves it closed as completed.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as IssueLinks from "../issueLinks/IssueLinks.ts";
import { closingReferencesLive } from "../issueLinks/IssueLinks.testFixtures.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as IssueService from "./IssueService.ts";

const live = process.env.T3CODE_ISSUES_LIVE === "1";
const fixtureNumber = Number(process.env.T3CODE_ISSUES_LIVE_FIXTURE ?? "");
const hasFixture = Number.isInteger(fixtureNumber) && fixtureNumber > 0;

const project = (
  id: string,
  provider: string,
  host: string,
  owner: string,
  name: string,
): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: `${owner}/${name}`,
  // `gh` names every repository itself, so any existing directory serves as the checkout.
  workspaceRoot: process.cwd(),
  repositoryIdentity: {
    canonicalKey: `${host}/${owner}/${name}`,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `https://${host}/${owner}/${name}.git`,
    },
    provider,
    owner,
    name,
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const projects = [
  project("t3code", "github", "github.com", "toolboxmd", "t3code"),
  // A worktree of the same repository is listed once.
  project("t3code-worktree", "github", "github.com", "toolboxmd", "t3code"),
  project("model-router", "github", "github.com", "toolboxmd", "model-router"),
  project("gitlab", "gitlab", "gitlab.com", "someone", "elsewhere"),
  // Unsupported repositories are counted once too, not per worktree.
  project("gitlab-worktree", "gitlab", "gitlab.com", "someone", "elsewhere"),
];

// Only the project list is read; the rest of the query service is not reached.
const projectionsLayer = Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
  getProjectShells: () => Effect.succeed(projects),
} as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]);

const layer = IssueService.layer.pipe(
  // No threads: nothing linked is read alongside the search.
  Layer.provide(IssueLinks.layer),
  Layer.provide(closingReferencesLive),
  Layer.provide(GitHubCli.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provide(projectionsLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

describe.skipIf(!live)("IssueService (live GitHub)", () => {
  it.layer(layer, { timeout: 120_000 })("reads", (it) => {
    it.effect("lists every project repository, once, and reports other forges", () =>
      Effect.gen(function* () {
        const issues = yield* IssueService.IssueService;
        const result = yield* issues.list({ state: "all", limit: 10 });
        expect(result.errors).toEqual([]);
        expect(result.repositories.map((repository) => repository.repository).toSorted()).toEqual([
          "toolboxmd/model-router",
          "toolboxmd/t3code",
        ]);
        expect(result.unsupported).toEqual([
          { host: "gitlab.com", repository: "someone/elsewhere" },
        ]);
        expect(result.entries.length).toBeGreaterThan(0);
        for (const entry of result.entries) {
          expect(["toolboxmd/model-router", "toolboxmd/t3code"]).toContain(entry.repository);
          expect(entry.url).toContain(`/${entry.repository}/issues/${entry.number}`);
        }
        const spec = result.entries.find(
          (entry) => entry.repository === "toolboxmd/t3code" && entry.number === 27,
        );
        if (spec !== undefined) {
          expect(spec.parent).toMatchObject({ repository: "toolboxmd/t3code", number: 25 });
        }
      }),
    );

    it.effect("pages through a repository with its continuation", () =>
      Effect.gen(function* () {
        const issues = yield* IssueService.IssueService;
        const input = {
          state: "all",
          sort: "created",
          repositories: ["github.com toolboxmd/t3code"],
          limit: 3,
        } as const;
        const first = yield* issues.list(input);
        expect(first.entries).toHaveLength(3);
        expect(Object.keys(first.nextCursors)).toEqual(["github.com#0"]);
        const second = yield* issues.list({ ...input, cursors: first.nextCursors });
        expect(second.entries).toHaveLength(3);
        const firstNumbers = first.entries.map((entry) => entry.number);
        for (const entry of second.entries) expect(firstNumbers).not.toContain(entry.number);
        // Created order, newest first, carries across the page boundary.
        expect(Math.min(...firstNumbers)).toBeGreaterThan(
          Math.max(...second.entries.map((entry) => entry.number)),
        );
      }),
    );

    it.effect("reads sub-Issues that live in other repositories", () =>
      Effect.gen(function* () {
        const issues = yield* IssueService.IssueService;
        const result = yield* issues.list({
          state: "all",
          repositories: ["github.com toolboxmd/model-router"],
          query: "Agent Observer",
          limit: 50,
        });
        const withForeignChildren = result.entries.find((entry) =>
          entry.subIssues.some((child) => child.repository !== entry.repository),
        );
        expect(withForeignChildren).toBeDefined();
        const foreign = withForeignChildren!.subIssues.filter(
          (child) => child.repository !== "toolboxmd/model-router",
        );
        expect(foreign.length).toBeGreaterThan(0);
        for (const child of foreign) {
          expect(child.host).toBe("github.com");
          expect(child.url).toContain(`/${child.repository}/issues/${child.number}`);
        }
      }),
    );

    it.effect("reads an Issue with its body and comments", () =>
      Effect.gen(function* () {
        const issues = yield* IssueService.IssueService;
        const detail = yield* issues.detail({
          host: "github.com",
          repository: "toolboxmd/t3code",
          number: 25,
        });
        expect(detail.title).toContain("Issues in Chromeria");
        expect(detail.body).toContain("## Outcome");
        expect(detail.comments.length).toBeLessThanOrEqual(detail.commentCount);
      }),
    );

    it.effect("reports a missing Issue as an operation error", () =>
      Effect.gen(function* () {
        const issues = yield* IssueService.IssueService;
        const error = yield* issues
          .detail({ host: "github.com", repository: "toolboxmd/t3code", number: 999_999 })
          .pipe(Effect.flip);
        expect(error._tag).toBe("IssueOperationError");
      }),
    );
  });

  it.layer(layer, { timeout: 180_000 })("fixture actions", (it) => {
    it.effect.skipIf(!hasFixture)("comments, closes as not planned, reopens and closes", () =>
      Effect.gen(function* () {
        const issues = yield* IssueService.IssueService;
        const ref = { host: "github.com", repository: "toolboxmd/t3code", number: fixtureNumber };
        const marker = `Live suite comment ${DateTime.formatIso(yield* DateTime.now)}`;
        yield* issues.comment({ ...ref, body: marker });
        const commented = yield* issues.detail(ref);
        expect(commented.comments.map((comment) => comment.body)).toContain(marker);

        yield* issues.setState({ ...ref, action: "close-not-planned" });
        expect((yield* issues.detail(ref)).state).toBe("not-planned");
        yield* issues.setState({ ...ref, action: "reopen" });
        expect((yield* issues.detail(ref)).state).toBe("open");
        // Left closed, as a fixture should be.
        yield* issues.setState({ ...ref, action: "close-completed" });
        expect((yield* issues.detail(ref)).state).toBe("done");

        const empty = yield* issues.comment({ ...ref, body: "   " }).pipe(Effect.flip);
        expect(empty.detail).toBe("The comment is empty.");
      }),
    );
  });
});
