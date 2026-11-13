import { SourceControlProviderKind } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { assert, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type {
  OrchestrationProjectShell,
  ProjectId,
  PullRequestReviewCapabilities,
  PullRequestReviewerCapabilities,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import type { ServerSettings } from "@t3tools/contracts";
import * as ServerSettingsService from "../serverSettings.ts";
import { PullRequestOperationError } from "@t3tools/contracts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import type { SourceControlProvider } from "@t3tools/source-control-core/server/SourceControlProvider";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { fakePullRequestProvider } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";

export function project(input: {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repository?: string;
  readonly provider?: string;
  readonly host?: string;
  readonly remoteUrl?: string;
}): OrchestrationProjectShell {
  const host = input.host ?? (input.provider === "gitlab" ? "gitlab.com" : "github.com");
  return {
    id: input.id as ProjectId,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    ...(input.repository
      ? {
          repositoryIdentity: {
            canonicalKey: `${host}/${input.repository}`,
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: input.remoteUrl ?? `https://${host}/${input.repository}.git`,
            },
            provider: SourceControlProviderKind.make(input.provider ?? "github"),
            displayName: input.repository,
          },
        }
      : {}),
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

export function changeRequest(number: number, updatedAt: string): ProviderChangeRequest {
  return {
    number,
    title: `Change request ${number}`,
    url: `https://host/pull/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feat/${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    reviewRequestLogins: [],
    labels: [],
  };
}

export function hostedChangeRequest(body: string, additions = 1) {
  return {
    ...changeRequest(1, "2026-07-02T00:00:00Z"),
    body,
    additions,
    changedFiles: 2,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    viewerPermissions: {
      actions: ["merge"] as const,
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"] as const,
      requestReviewers: true,
    },
  };
}

export function unusable(provider: SourceControlProviderKind, reason: "missing-tool" | "unauthenticated") {
  return new PullRequestProviderError({
    provider,
    operation: "getViewer",
    reason,
    detail: `${provider} is not usable.`,
  });
}

export const requestFailed = new PullRequestProviderError({
  provider: SourceControlProviderKind.make("github"),
  operation: "listChangeRequests",
  reason: "failed",
  detail: "HTTP 404",
});

export const FULL_REVIEW: PullRequestReviewCapabilities = {
  inlineComment: true,
  reply: true,
  resolve: true,
  verdicts: ["comment", "approve", "request-changes"],
};

export const FULL_REVIEWERS: PullRequestReviewerCapabilities = { request: true, listCandidates: true };

// Like Azure DevOps, whose repository names repeat across organizations and projects.

export const keyedByCanonicalKey = {
  repositoryKey: ({ canonicalKey }: { readonly canonicalKey: string }) => canonicalKey,
};

/** A host whose SSH remotes name an alias, so discovery says which server serves them. */

export const sshAliasHost = {
  resolveRemoteWebHost: ({ cwd, context, resolveContext }) =>
    isSshRemoteUrl(context.remoteUrl)
      ? resolveContext({
          cwd,
          context: {
            ...context,
            provider: { kind: SourceControlProviderKind.make("unknown"), name: "", baseUrl: "" },
          },
        }).pipe(
          Effect.map((resolved) =>
            resolved === null || resolved.provider.kind === "unknown"
              ? null
              : new URL(resolved.provider.baseUrl).host,
          ),
        )
      : Effect.succeed(null),
} as SourceControlProvider["Service"];

export function makeService(input: {
  readonly settings?: ServerSettings;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly providers: ReadonlyArray<PullRequestProviderApi>;
  readonly resolveHandle?: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"]["resolveHandle"];
  readonly resolveRepositoryIdentity?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]["resolve"];
  readonly onProjectRead?: () => void;
}) {
  // Build in the test scope; per-call Effect.provide would close the marks database on service acquisition.
  return Effect.flatMap(
    Layer.build(
      Layer.mergeAll(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed(input.settings ?? DEFAULT_SERVER_SETTINGS),
        }),
        Layer.succeed(
          PullRequestProviderRegistry.PullRequestProviderRegistry,
          PullRequestProviderRegistry.fromProviders(input.providers),
        ),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
          resolveHandle:
            input.resolveHandle ?? (() => Effect.die("Unexpected provider refinement")),
          get: (kind) =>
            Effect.succeed(
              kind === "forgejo" ? sshAliasHost : ({} as SourceControlProvider["Service"]),
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          listShells: (options) =>
            Effect.sync(() => {
              input.onProjectRead?.();
              return input.projects.filter(
                (project) => options?.projectIds?.includes(project.id) ?? true,
              );
            }),
          getShell: (projectId) =>
            Effect.sync(() => {
              input.onProjectRead?.();
              return Option.fromNullishOr(input.projects.find((p) => p.id === projectId));
            }),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: input.resolveRepositoryIdentity ?? (() => Effect.succeed(null)),
        }),
        SourceControlRateLimit.layer,
        PullRequestFilesViewed.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        Layer.effect(PullRequestReadCache.PullRequestReadCache, PullRequestReadCache.make).pipe(
          Layer.provide(KeyValueStore.layerMemory),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
    (context) => Effect.provideContext(PullRequestService.make, context),
  );
}

export function batchedChangeRequest(number: number, repository: string, updatedAt: string) {
  return { ...changeRequest(number, updatedAt), repository };
}

export const environmentViewedProvider = (
  revisions: Map<string, string>,
  asked: Array<ReadonlyArray<string>>,
  unreadable: ReadonlySet<string> = new Set(),
) =>
  fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge"],
      mergeMethods: ["merge"],
      search: true,
      reactions: true,
      viewedFiles: "environment",
      review: FULL_REVIEW,
      reviewers: FULL_REVIEWERS,
    },
    getFilesViewed: () => Effect.die("the host keeps no marks of its own"),
    setFilesViewed: () => Effect.die("the host keeps no marks of its own"),
    getChangeRequestSummary: () => Effect.succeed(changeRequest(1, "2026-07-02T00:00:00Z")),
    getFileRevisions: (input) => {
      asked.push(input.paths);
      return Effect.succeed({
        revisions: new Map(
          input.paths.flatMap((path) =>
            unreadable.has(path) ? [] : [[path, revisions.get(path) ?? ""] as const],
          ),
        ),
      });
    },
  });

export const environmentViewedService = (
  revisions: Map<string, string>,
  asked: Array<ReadonlyArray<string>>,
  unreadable: ReadonlySet<string> = new Set(),
) =>
  makeService({
    projects: [
      project({
        id: "p1",
        title: "on gitlab",
        workspaceRoot: "/a",
        repository: "group/project",
        provider: SourceControlProviderKind.make("gitlab"),
      }),
    ],
    providers: [environmentViewedProvider(revisions, asked, unreadable)],
  });

export const GITLAB_REFERENCE = {
  projectId: "p1" as ProjectId,
  repository: "group/project",
  number: 1,
};

export const azureViewedService = (projects: ReadonlyArray<OrchestrationProjectShell>) =>
  makeService({
    projects,
    providers: [
      fakePullRequestProvider(SourceControlProviderKind.make("azure-devops"), {
        ...keyedByCanonicalKey,
        capabilities: {
          diff: true,
          comment: true,
          actions: ["merge"],
          mergeMethods: ["merge"],
          search: true,
          reactions: true,
          viewedFiles: "environment",
          review: FULL_REVIEW,
          reviewers: FULL_REVIEWERS,
        },
        getFilesViewed: () => Effect.die("the host keeps no marks of this environment's own"),
        setFilesViewed: () => Effect.die("the host keeps no marks of this environment's own"),
        getFileRevisions: (input) =>
          Effect.succeed({ revisions: new Map(input.paths.map((path) => [path, "blob-a"])) }),
      }),
    ],
  });

export const AZURE_PAIR = [
  project({
    id: "p1",
    title: "platform web",
    workspaceRoot: "/a",
    repository: "acme/platform/_git/web",
    provider: SourceControlProviderKind.make("azure-devops"),
    host: "dev.azure.com",
  }),
  project({
    id: "p2",
    title: "other web",
    workspaceRoot: "/b",
    repository: "acme/other/_git/web",
    provider: SourceControlProviderKind.make("azure-devops"),
    host: "dev.azure.com",
  }),
];

export const AZURE_PLATFORM = { projectId: "p1" as ProjectId, repository: "web", number: 1 };

export const AZURE_OTHER = { projectId: "p2" as ProjectId, repository: "web", number: 1 };

export const environmentViewedServiceWithViewer = (
  revisions: Map<string, string>,
  getViewer: PullRequestProviderApi["getViewer"],
) =>
  makeService({
    projects: [
      project({
        id: "p1",
        title: "on gitlab",
        workspaceRoot: "/a",
        repository: "group/project",
        provider: SourceControlProviderKind.make("gitlab"),
      }),
    ],
    providers: [{ ...environmentViewedProvider(revisions, []), getViewer }],
  });
