import { assert, it, vi } from "@effect/vitest";
import type { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubIssueService from "./GitHubIssueService.ts";

function project(input: {
  id: string;
  title: string;
  workspaceRoot: string;
  repository: string;
  provider?: string;
  host?: string;
}): OrchestrationProjectShell {
  const host = input.host ?? "github.com";
  return {
    id: input.id as ProjectId,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    repositoryIdentity: {
      canonicalKey: `${host}/${input.repository}`,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `https://${host}/${input.repository}.git`,
      },
      provider: input.provider ?? "github",
      displayName: input.repository,
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt: "2026-08-20T00:00:00Z",
  };
}

function output(stdout: string) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function issue(number: number, updatedAt = "2026-08-21T00:00:00Z") {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/web/issues/${number}`,
    author: { login: "octocat", name: null },
    assignees: [],
    labels: [],
    state: "OPEN",
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt,
  };
}

function makeService(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  execute: GitHubCli.GitHubCli["Service"]["execute"],
) {
  return GitHubIssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitHubCli.GitHubCli)({ execute }),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects,
              threads: [],
              updatedAt: "2026-08-21T00:00:00Z",
            }),
        }),
      ),
    ),
  );
}

it.effect("lists GitHub issues for local projects and forwards filters", () =>
  Effect.gen(function* () {
    const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>(() =>
      Effect.succeed(output(JSON.stringify([issue(2), issue(1)]))),
    );
    const service = yield* makeService(
      [
        project({ id: "p1", title: "web", workspaceRoot: "/web", repository: "acme/web" }),
        project({
          id: "p2",
          title: "gitlab",
          workspaceRoot: "/other",
          repository: "acme/other",
          provider: "gitlab",
        }),
      ],
      execute,
    );

    const result = yield* service.list({ state: "open", query: "websocket", limit: 1 });

    assert.strictEqual(execute.mock.calls.length, 1);
    assert.deepStrictEqual(execute.mock.calls[0]?.[0].args, [
      "issue",
      "list",
      "--repo",
      "acme/web",
      "--state",
      "open",
      "--limit",
      "2",
      "--json",
      "number,title,url,author,assignees,labels,state,createdAt,updatedAt",
      "--search",
      "websocket",
    ]);
    assert.strictEqual(result.entries[0]?.number, 2);
    assert.strictEqual(result.entries[0]?.projectId, "p1");
    assert.strictEqual(result.truncated, true);
  }),
);

it.effect("applies the result limit across repositories after sorting", () =>
  Effect.gen(function* () {
    const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>((input) =>
      Effect.succeed(
        output(
          JSON.stringify(
            input.cwd === "/web"
              ? [issue(1, "2026-08-21T01:00:00Z")]
              : [issue(2, "2026-08-21T02:00:00Z")],
          ),
        ),
      ),
    );
    const service = yield* makeService(
      [
        project({ id: "p1", title: "web", workspaceRoot: "/web", repository: "acme/web" }),
        project({ id: "p2", title: "api", workspaceRoot: "/api", repository: "acme/api" }),
      ],
      execute,
    );

    const result = yield* service.list({ state: "all", limit: 1 });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [2],
    );
    assert.strictEqual(result.truncated, true);
  }),
);

it.effect("loads issue detail with its discussion and workspace", () =>
  Effect.gen(function* () {
    const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>(() =>
      Effect.succeed(
        output(
          JSON.stringify({
            ...issue(42),
            body: "Visible issue body",
            closedAt: null,
            comments: [
              {
                id: "comment-1",
                author: { login: "reviewer", name: null },
                body: "Please fix this.",
                createdAt: "2026-08-21T01:00:00Z",
                url: "https://github.com/acme/web/issues/42#issuecomment-1",
              },
            ],
          }),
        ),
      ),
    );
    const service = yield* makeService(
      [project({ id: "p1", title: "web", workspaceRoot: "/web", repository: "acme/web" })],
      execute,
    );

    const detail = yield* service.detail({
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      number: 42,
    });

    assert.strictEqual(detail.workspaceRoot, "/web");
    assert.strictEqual(detail.body, "Visible issue body");
    assert.strictEqual(detail.commentCount, 1);
    assert.strictEqual(detail.comments[0]?.author?.login, "reviewer");
  }),
);

it.effect("keeps issues from signed-in hosts when one remote is unauthenticated", () =>
  Effect.gen(function* () {
    const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>((input) =>
      input.cwd === "/enterprise"
        ? Effect.fail(
            new GitHubCli.GitHubCliAuthenticationError({
              command: "gh",
              cwd: input.cwd,
              cause: new Error("gh auth login"),
            }),
          )
        : Effect.succeed(output(JSON.stringify([issue(7)]))),
    );
    const service = yield* makeService(
      [
        project({ id: "p1", title: "web", workspaceRoot: "/web", repository: "acme/web" }),
        project({
          id: "p2",
          title: "internal",
          workspaceRoot: "/enterprise",
          repository: "acme/internal",
          host: "ghe.acme.dev",
        }),
      ],
      execute,
    );

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [7],
    );
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0]?.projectId, "p2");
    // The host is named because it is the one the reader has to sign in to.
    assert.include(result.errors[0]?.message ?? "", "ghe.acme.dev");
  }),
);

it.effect("returns host-scoped errors when every host is unauthenticated", () =>
  Effect.gen(function* () {
    const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>((input) =>
      Effect.fail(
        new GitHubCli.GitHubCliAuthenticationError({
          command: "gh",
          cwd: input.cwd,
          cause: new Error("gh auth login"),
        }),
      ),
    );
    const service = yield* makeService(
      [
        project({
          id: "p1",
          title: "internal",
          workspaceRoot: "/enterprise",
          repository: "acme/internal",
          host: "ghe.acme.dev",
        }),
      ],
      execute,
    );

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(result.entries, []);
    assert.strictEqual(result.errors.length, 1);
    assert.include(result.errors[0]?.message ?? "", "gh auth login --hostname ghe.acme.dev");
  }),
);

it.effect("fails the whole read when the GitHub CLI is missing", () =>
  Effect.gen(function* () {
    const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>((input) =>
      input.cwd === "/web"
        ? Effect.fail(
            new GitHubCli.GitHubCliUnavailableError({
              command: "gh",
              cwd: input.cwd,
              cause: new Error("spawn gh ENOENT"),
            }),
          )
        : Effect.succeed(output(JSON.stringify([issue(9)]))),
    );
    const service = yield* makeService(
      [
        project({ id: "p1", title: "web", workspaceRoot: "/web", repository: "acme/web" }),
        project({ id: "p2", title: "api", workspaceRoot: "/api", repository: "acme/api" }),
      ],
      execute,
    );

    const error = yield* service.list({ state: "open" }).pipe(Effect.flip);

    assert.strictEqual(error._tag, "GitHubIssueCliMissingError");
  }),
);
