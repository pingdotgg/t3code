import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  IssueTrackerKind,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
  type TrackerIssueDetail,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const GITHUB = IssueTrackerKind.make("github");

function project(input: {
  readonly id: string;
  readonly repository?: string;
  readonly provider?: string;
  readonly host?: string;
}): OrchestrationProjectShell {
  const host = input.host ?? "github.com";
  return {
    id: input.id as ProjectId,
    title: input.id,
    workspaceRoot: `/w/${input.id}`,
    ...(input.repository
      ? {
          repositoryIdentity: {
            canonicalKey: `${host}/${input.repository}`,
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: `https://${host}/${input.repository}.git`,
            },
            provider: input.provider ?? "github",
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

function issue(key: string, updatedAt = "2026-07-02T00:00:00Z"): TrackerIssueDetail {
  return {
    key,
    displayKey: `#${key}`,
    title: `Issue ${key}`,
    url: `https://github.com/acme/web/issues/${key}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    body: "",
    viewer: "julius",
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
    comments: [],
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
  };
}

function fakeTracker(overrides: Partial<IssueTrackerApi> = {}): IssueTrackerApi {
  return {
    kind: GITHUB,
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: false,
      templates: false,
      linkedPullRequests: true,
      events: true,
      search: true,
      states: [
        { category: "open", name: "open" },
        { category: "closed", name: "closed" },
      ],
      closeReasons: ["completed"],
    },
    getViewer: () => Effect.succeed("julius"),
    listIssues: () => Effect.succeed({ items: [], nextCursor: null }),
    getIssue: (input) => Effect.succeed(issue(input.key)),
    getComments: () => Effect.succeed({ comments: [], nextCursor: null }),
    getViewerPermissions: () => Effect.die("unused"),
    comment: () => Effect.void,
    update: () => Effect.void,
    setState: () => Effect.void,
    ...overrides,
  };
}

function makeService(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly trackers: ReadonlyArray<IssueTrackerApi>;
}) {
  return IssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          IssueTrackerRegistry.IssueTrackerRegistry,
          IssueTrackerRegistry.fromTrackers(input.trackers),
        ),
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.succeed(input.projects),
          getShell: (projectId) =>
            Effect.succeed(Option.fromNullishOr(input.projects.find((p) => p.id === projectId))),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
        }),
      ),
    ),
  );
}

describe("resolveGitHostBinding", () => {
  it("scopes Azure DevOps work items to the project rather than the repository", () => {
    expect(
      IssueService.resolveGitHostBinding(
        project({
          id: "p",
          provider: "azure-devops",
          host: "dev.azure.com",
          repository: "acme/Web App/_git/web",
        }),
      ),
    ).toEqual({ tracker: "azure-devops", host: "dev.azure.com", scope: "acme/Web App" });
    expect(
      IssueService.resolveGitHostBinding(
        project({ id: "p", provider: "azure-devops", host: "dev.azure.com", repository: "web" }),
      ),
    ).toBeNull();
  });
});

describe("IssueService", () => {
  it.effect("reads another repository on the same host but refuses to write to it", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            comment: (input) =>
              Effect.sync(() => {
                writes.push(`${input.scope}#${input.key}`);
              }),
          }),
        ],
      });
      const own = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };
      const external = { ...own, scope: "other/backend", key: "7" };

      expect((yield* service.detail(own)).writable).toBe(true);
      // The external issue is served by the project's checkout and credentials, read-only.
      const detail = yield* service.detail(external);
      expect(detail).toMatchObject({ writable: false, scope: "other/backend", key: "7" });

      yield* service.comment({ ...own, body: "ok" });
      const refused = yield* Effect.flip(service.comment({ ...external, body: "no" }));
      expect(refused).toMatchObject({ _tag: "IssueOperationError", reason: "read-only" });
      expect(writes).toEqual(["acme/web#1"]);

      // Another host is not reachable through this project's credentials at all.
      const elsewhere = yield* Effect.flip(service.detail({ ...own, host: "ghe.example.test" }));
      expect(elsewhere).toMatchObject({
        _tag: "IssueUnavailableError",
        reason: "tracker-unsupported",
      });
    }),
  );

  it.effect("refuses what the tracker did not declare before calling it", () =>
    Effect.gen(function* () {
      let calls = 0;
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            setState: () =>
              Effect.sync(() => {
                calls += 1;
              }),
            setReaction: () =>
              Effect.sync(() => {
                calls += 1;
              }),
          }),
        ],
      });
      const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };

      yield* service.setState({ ...ref, state: "closed", closeReason: "completed" });
      const unknownState = yield* Effect.flip(service.setState({ ...ref, state: "In Review" }));
      expect(unknownState._tag).toBe("IssueOperationError");
      const unknownReason = yield* Effect.flip(
        service.setState({ ...ref, state: "closed", closeReason: "not-planned" }),
      );
      expect(unknownReason._tag).toBe("IssueOperationError");
      const reaction = yield* Effect.flip(
        service.react({ ...ref, content: "heart", reacted: true }),
      );
      expect(reaction._tag).toBe("IssueOperationError");
      expect(calls).toBe(1);
    }),
  );

  it.effect("lists each repository once and reports unusable trackers per host", () =>
    Effect.gen(function* () {
      const listed: string[] = [];
      const service = yield* makeService({
        projects: [
          project({ id: "web", repository: "acme/web" }),
          project({ id: "web-worktree", repository: "acme/web" }),
          project({ id: "api", repository: "acme/api" }),
          project({ id: "gitlab", repository: "acme/gl", provider: "gitlab", host: "gitlab.com" }),
          project({ id: "plain" }),
        ],
        trackers: [
          fakeTracker({
            listIssues: (input) =>
              Effect.gen(function* () {
                listed.push(input.scope);
                if (input.scope === "acme/api")
                  return yield* new IssueTrackerError({
                    tracker: GITHUB,
                    operation: "listIssues",
                    reason: "failed",
                    detail: "boom",
                  });
                return {
                  items: [issue("2", "2026-07-05T00:00:00Z"), issue("1")],
                  nextCursor: "next",
                };
              }),
          }),
        ],
      });
      const result = yield* service.list({ state: "open" });
      expect(listed.sort()).toEqual(["acme/api", "acme/web"]);
      expect(result.entries.map((entry) => [entry.projectId, entry.key])).toEqual([
        ["web", "2"],
        ["web", "1"],
      ]);
      expect(result.nextCursors).toEqual({ "github.com acme/web": "next" });
      expect(result.errors).toEqual([{ projectId: "api", projectTitle: "api", message: "boom" }]);
      expect(result.viewers).toEqual({ "github.com": "julius" });
      expect(result.trackers).toEqual([
        expect.objectContaining({ host: "github.com", projectCount: 3, configured: true }),
        expect.objectContaining({
          host: "gitlab.com",
          tracker: "gitlab",
          projectCount: 1,
          configured: false,
          capabilities: null,
        }),
      ]);

      // A continuation only reads the scopes it names.
      listed.length = 0;
      const next = yield* service.list({
        state: "open",
        cursors: { "github.com acme/web": "next" },
      });
      expect(listed).toEqual(["acme/web"]);
      expect(next.errors).toEqual([]);
    }),
  );
});
