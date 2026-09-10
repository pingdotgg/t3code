import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { issueSourceKey, type OrchestrationProjectShell, type ProjectId } from "@t3tools/contracts";

import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import type { IssueAdapter } from "./IssueProvider.ts";
import { fromProviders } from "./IssueProviderRegistry.ts";

const PROJECT: OrchestrationProjectShell = {
  id: "p1" as ProjectId,
  title: "web",
  workspaceRoot: "/work/web",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

it.effect("binds a project to an issue adapter without source-control types", () =>
  Effect.gen(function* () {
    const jira = {
      kind: "jira",
      resolveSource: () => Effect.succeed({ host: "acme.atlassian.net", repository: "ACME" }),
    } as unknown as IssueAdapter;
    const registry = fromProviders([jira]);

    const result = yield* registry.resolveProjects([PROJECT], {});

    assert.strictEqual(result.supported.length, 1);
    assert.strictEqual(result.supported[0]?.adapter, jira);
    assert.deepStrictEqual(
      result.supported.map(({ host, repository }) => ({ host, repository })),
      [{ host: "acme.atlassian.net", repository: "ACME" }],
    );
    assert.deepStrictEqual(
      result.viewerRoots,
      new Map([[issueSourceKey("jira", "acme.atlassian.net"), ["/work/web"]]]),
    );
  }),
);

it.effect("keeps two adapters that share one host and repository", () =>
  Effect.gen(function* () {
    const sourceProject: OrchestrationProjectShell = {
      ...PROJECT,
      repositoryIdentity: {
        canonicalKey: "tracker.example.test/acme/web",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://tracker.example.test/acme/web.git",
        },
        provider: "github",
        displayName: "acme/web",
      },
    };
    const github = { kind: "github" } as unknown as IssueAdapter;
    const jira = {
      kind: "jira",
      resolveSource: (candidate: OrchestrationProjectShell) =>
        Effect.succeed(
          candidate.id === "p2" ? { host: "tracker.example.test", repository: "acme/web" } : null,
        ),
    } as unknown as IssueAdapter;
    const registry = fromProviders([github, jira]);

    const result = yield* registry.resolveProjects(
      [
        sourceProject,
        { ...PROJECT, id: "p2" as ProjectId, title: "planning", workspaceRoot: "/planning" },
      ],
      {},
    );

    assert.deepStrictEqual(result.supported.map(({ adapter }) => adapter.kind).toSorted(), [
      "github",
      "jira",
    ]);
  }),
);

it.effect("keeps source-control and external issue sources for one project", () =>
  Effect.gen(function* () {
    const project: OrchestrationProjectShell = {
      ...PROJECT,
      repositoryIdentity: {
        canonicalKey: "github.com/acme/web",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/acme/web.git",
        },
        provider: "github",
        displayName: "acme/web",
      },
    };
    const github = { kind: "github" } as unknown as IssueAdapter;
    const linear = {
      kind: "linear",
      resolveSource: () => Effect.succeed({ host: "linear.app", repository: "ENG" }),
    } as unknown as IssueAdapter;
    const registry = fromProviders([github, linear]);

    const result = yield* registry.resolveProjects([project], {});

    assert.deepStrictEqual(
      result.supported
        .map(({ adapter, host, repository }) => ({ kind: adapter.kind, host, repository }))
        .toSorted((left, right) => left.kind.localeCompare(right.kind)),
      [
        { kind: "github", host: "github.com", repository: "acme/web" },
        { kind: "linear", host: "linear.app", repository: "ENG" },
      ],
    );
  }),
);

it.effect("keeps account-bound sources distinct on linear.app", () =>
  Effect.gen(function* () {
    const linear = {
      kind: "linear",
      resolveSource: (candidate: OrchestrationProjectShell) =>
        Effect.succeed({
          host: "linear.app",
          repository: candidate.id === "p1" ? "ENG" : "OPS",
          credentialId: candidate.id === "p1" ? "user-1" : "user-2",
        }),
    } as unknown as IssueAdapter;
    const registry = fromProviders([linear]);

    const result = yield* registry.resolveProjects(
      [PROJECT, { ...PROJECT, id: "p2" as ProjectId, workspaceRoot: "/work/api" }],
      {},
    );

    assert.deepStrictEqual(
      result.supported.map(({ credentialId, repository }) => [credentialId, repository]),
      [
        ["user-1", "ENG"],
        ["user-2", "OPS"],
      ],
    );
    assert.strictEqual(result.viewerRoots.size, 2);
    assert.deepStrictEqual([...result.viewerRoots.values()].flat().toSorted(), [
      "/work/api",
      "/work/web",
    ]);
  }),
);

it.effect("derives a self-hosted hostname from a legacy remote identity", () =>
  Effect.gen(function* () {
    const project: OrchestrationProjectShell = {
      ...PROJECT,
      repositoryIdentity: {
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://code.example.test/group/project.git",
        },
        provider: "gitlab",
        displayName: "group/project",
      } as unknown as OrchestrationProjectShell["repositoryIdentity"],
    };
    const registry = fromProviders([{ kind: "gitlab" } as unknown as IssueAdapter]);

    const result = yield* registry.resolveProjects([project], {});

    assert.strictEqual(result.supported[0]?.host, "code.example.test");
  }),
);

it.effect("refines one unknown remote before de-duplicating its worktrees", () =>
  Effect.gen(function* () {
    let refinementCalls = 0;
    const selfHosted: OrchestrationProjectShell = {
      ...PROJECT,
      repositoryIdentity: {
        canonicalKey: "code.example.test/group/project",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://code.example.test/group/project.git",
        },
        provider: "unknown",
        displayName: "group/project",
      } as unknown as OrchestrationProjectShell["repositoryIdentity"],
    };
    const sourceControl = SourceControlProviderRegistry.SourceControlProviderRegistry.of({
      get: () => Effect.die("unused"),
      resolve: () => Effect.die("unused"),
      discover: Effect.die("unused"),
      resolveHandle: ({ context }) => {
        refinementCalls += 1;
        return Effect.succeed({
          provider: undefined as never,
          context: { ...context!, provider: { ...context!.provider, kind: "gitlab" } },
        });
      },
    });
    const gitlab = { kind: "gitlab" } as unknown as IssueAdapter;
    const registry = fromProviders([gitlab], sourceControl);

    const result = yield* registry.resolveProjects(
      [selfHosted, { ...selfHosted, id: "p2" as ProjectId, workspaceRoot: "/worktree" }],
      { host: "code.example.test" },
    );

    assert.strictEqual(refinementCalls, 1);
    assert.strictEqual(result.supported.length, 1);
    assert.strictEqual(result.supported[0]?.adapter, gitlab);
    assert.deepStrictEqual(
      result.viewerRoots,
      new Map([[issueSourceKey("gitlab", "code.example.test"), ["/work/web", "/worktree"]]]),
    );
  }),
);
