import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  IssueTrackerKind,
  type IssueTrackerProjectBinding,
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
  type StandaloneIssueTrackerApi,
  type TrackerIssueDetail,
} from "@t3tools/source-control-core/server/IssueTracker";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";

import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const GITHUB = IssueTrackerKind.make("github");
const LINEAR = IssueTrackerKind.make("linear");

/** A standalone tracker shaped like Linear: its own host, team keys for scopes, `ENG-1` keys. */
function fakeStandaloneTracker(
  overrides: Partial<IssueTrackerApi> = {},
): StandaloneIssueTrackerApi {
  return {
    ...fakeTracker({
      getViewer: () => Effect.succeed("usr_julius"),
      getIssue: (input) =>
        Effect.succeed({
          ...issue(input.key),
          url: `https://linear.app/acme/issue/${input.key}/canonical-title`,
          displayKey: input.key,
          viewer: "usr_julius",
        }),
      ...overrides,
    }),
    kind: LINEAR,
    standalone: {
      tracker: LINEAR,
      displayName: "Linear",
      host: "linear.app",
      scopeNoun: "team",
      credential: { label: "Personal API key", helpUrl: null },
    },
    parseIssueUrl: (url) => {
      const links = new Map([
        ["https://linear.app/acme/issue/ENG-1/old-title", "acme"],
        ["https://linear.app/acme/issue/ENG-1/issue-title", "acme"],
        ["https://linear.app/acme/issue/ENG-1/canonical-title", "acme"],
        ["https://linear.app/other-workspace/issue/ENG-1/old-title", "other-workspace"],
      ]);
      const workspace = links.get(url.href);
      return workspace === undefined
        ? null
        : { host: "linear.app", workspace, scope: "ENG", key: "ENG-1" };
    },
    probeCredential: () => Effect.succeed({ account: "julius", scopes: [] }),
  };
}

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
            canonicalKey: normalizeGitRemoteUrl(`https://${host}/${input.repository}.git`),
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: `https://${host}/${input.repository}.git`,
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
    states: [],
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
    },
    getViewer: () => Effect.succeed("julius"),
    listIssues: () => Effect.succeed({ items: [], nextCursor: null }),
    getIssue: (input) => Effect.succeed(issue(input.key)),
    getComments: () => Effect.succeed({ comments: [], nextCursor: null }),
    comment: () => Effect.void,
    update: () => Effect.void,
    setState: () => Effect.void,
    ...overrides,
  };
}

function makeService(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly trackers: ReadonlyArray<IssueTrackerApi>;
  readonly bindings?: Record<string, IssueTrackerProjectBinding>;
  readonly bindingsFailure?: PersistenceSqlError;
}) {
  return IssueService.IssueService.pipe(
    Effect.provide(
      IssueService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
              list:
                input.bindingsFailure !== undefined
                  ? Effect.fail(input.bindingsFailure)
                  : Effect.succeed(
                      new Map(
                        Object.entries(input.bindings ?? {}).map(([id, binding]) => [
                          id as ProjectId,
                          binding,
                        ]),
                      ),
                    ),
            }),
            Layer.succeed(
              IssueTrackerRegistry.IssueTrackerRegistry,
              IssueTrackerRegistry.fromTrackers(input.trackers),
            ),
            Layer.mock(ProjectService.ProjectService)({
              listShells: () => Effect.succeed(input.projects),
              getShell: (projectId) =>
                Effect.succeed(
                  Option.fromNullishOr(input.projects.find((p) => p.id === projectId)),
                ),
            }),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () => Effect.succeed(null),
            }),
          ),
        ),
      ),
    ),
  );
}

describe("IssueService", () => {
  it.effect("places a project where its host keeps its issues", () =>
    Effect.gen(function* () {
      const azure = IssueTrackerKind.make("azure-devops");
      const service = yield* makeService({
        projects: [
          project({
            id: "p",
            provider: "azure-devops",
            host: "dev.azure.com",
            repository: "acme/Web App/_git/web",
          }),
        ],
        trackers: [fakeTracker({ kind: azure })],
      });
      expect(yield* service.projectScope("p" as ProjectId)).toEqual({
        projectId: "p",
        tracker: "azure-devops",
        host: "dev.azure.com",
        scope: "acme/Web App",
      });
    }),
  );

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
      const refused = yield* service.comment({ ...external, body: "no" }).pipe(Effect.result);
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "IssueOperationError", reason: "read-only" },
      });
      expect(writes).toEqual(["acme/web#1"]);

      // A link's port picks the server: the project bound with it, not a default-port namesake.
      const ported = yield* makeService({
        projects: [
          project({ id: "plain", repository: "acme/web", provider: "forgejo", host: "gitea.test" }),
          project({
            id: "ported",
            repository: "acme/web",
            provider: "forgejo",
            host: "gitea.test:8443",
          }),
        ],
        trackers: [fakeTracker({ kind: IssueTrackerKind.make("forgejo") })],
      });
      expect(yield* ported.resolveUrl("https://gitea.test:8443/acme/web/issues/3")).toMatchObject({
        projectId: "ported",
        host: "gitea.test:8443",
        key: "3",
        writable: true,
      });
      expect(yield* ported.resolveUrl("https://gitea.test/acme/web/issues/3")).toMatchObject({
        projectId: "plain",
        host: "gitea.test",
      });

      // A GitHub Enterprise Server's hostname need not say "github"; its project vouches for it.
      const enterprise = yield* makeService({
        projects: [project({ id: "ghes", repository: "acme/web", host: "code.acme.test" })],
        trackers: [fakeTracker()],
      });
      expect(
        yield* enterprise.resolveUrl("https://code.acme.test/acme/web/issues/7"),
      ).toMatchObject({ projectId: "ghes", host: "code.acme.test", key: "7", writable: true });

      // Another host is not reachable through this project's credentials at all.
      const elsewhere = yield* Effect.flip(service.detail({ ...own, host: "ghe.example.test" }));
      expect(elsewhere).toMatchObject({
        _tag: "IssueUnavailableError",
        reason: "tracker-unsupported",
      });
    }),
  );

  it.effect("sends writes as interactive requests and reads as background ones", () =>
    Effect.gen(function* () {
      const interactive: Array<readonly [string, boolean]> = [];
      const record = (operation: string) =>
        Effect.gen(function* () {
          interactive.push([operation, yield* SourceControlRateLimit.Interactive]);
        });
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            getComments: () =>
              record("comments").pipe(Effect.as({ comments: [], nextCursor: null })),
            comment: () => record("comment"),
          }),
        ],
      });
      const ref = {
        projectId: "web" as ProjectId,
        tracker: GITHUB,
        scope: "acme/web",
        key: "42",
      };
      yield* service.comments({ ...ref, cursor: "next" });
      yield* service.comment({ ...ref, body: "Repro attached." });
      expect(interactive).toEqual([
        ["comments", false],
        ["comment", true],
      ]);
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

      // The state is the tracker's own name, passed through: the tracker is what proves it.
      yield* service.setState({ ...ref, state: "In Review" });
      const reaction = yield* Effect.flip(
        service.react({ ...ref, content: "heart", reacted: true }),
      );
      expect(reaction._tag).toBe("IssueOperationError");
      expect(calls).toBe(1);
    }),
  );

  it.effect("deduplicates and pages repositories despite partial failures", () =>
    Effect.gen(function* () {
      const listed: string[] = [];
      let failContinuation = true;
      const service = yield* makeService({
        projects: [
          project({ id: "web", repository: "Acme/Web" }),
          project({ id: "web-worktree", repository: "acme/web" }),
          project({ id: "api", repository: "acme/api" }),
          project({ id: "docs", repository: "acme/docs" }),
          project({
            id: "gitlab",
            repository: "acme/gl",
            provider: "gitlab",
            host: "gitlab.com",
          }),
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
                    // A tracker may fail without a detail; the wire error still needs one.
                    detail: " ",
                  });
                if (input.scope === "acme/docs")
                  return { items: [issue("3", "2026-07-04T00:00:00Z")], nextCursor: null };
                if (input.cursor === "next" && failContinuation) {
                  failContinuation = false;
                  return yield* new IssueTrackerError({
                    tracker: GITHUB,
                    operation: "listIssues",
                    reason: "failed",
                    detail: "try again",
                  });
                }
                if (input.cursor === "next")
                  return { items: [issue("4", "2026-07-01T00:00:00Z")], nextCursor: null };
                return {
                  items: [issue("1"), issue("2", "2026-07-05T00:00:00Z")],
                  nextCursor: "next",
                };
              }),
          }),
        ],
      });
      const result = yield* service.list({ state: "open" });
      expect(listed.sort()).toEqual(["Acme/Web", "acme/api", "acme/docs"]);
      expect(result.entries.map((entry) => [entry.projectId, entry.key])).toEqual([
        ["web", "2"],
        ["docs", "3"],
        ["web", "1"],
      ]);
      expect(
        result.entries.filter((entry) => entry.projectId === "web").map((entry) => entry.scope),
      ).toEqual(["Acme/Web", "Acme/Web"]);
      expect(result.nextCursors).toEqual({ "github.com acme/web": "next" });
      expect(result.errors).toEqual([
        { projectId: "api", projectTitle: "api", message: "The issue tracker request failed." },
      ]);
      expect(result.viewers).toEqual({});
      expect(result.trackers).toEqual([
        expect.objectContaining({ host: "github.com", projectCount: 4, configured: true }),
        expect.objectContaining({
          host: "gitlab.com",
          tracker: "gitlab",
          projectCount: 1,
          configured: false,
          capabilities: null,
        }),
      ]);

      // Narrowing to one host still names every tracker, so the client can switch between them.
      // Narrowing by involvement reads the account it compares against.
      const narrowed = yield* service.list({
        state: "open",
        host: "github.com",
        involvement: "assigned",
      });
      expect(narrowed.viewers).toEqual({ "github.com": "julius" });
      expect(narrowed.entries.every((entry) => entry.host === "github.com")).toBe(true);
      expect(narrowed.trackers.map((tracker) => tracker.host)).toEqual([
        "github.com",
        "gitlab.com",
      ]);

      // A continuation only reads the scopes it names.
      listed.length = 0;
      const failed = yield* service.list({
        state: "open",
        cursors: result.nextCursors,
      });
      expect(listed).toEqual(["Acme/Web"]);
      expect(failed.nextCursors).toEqual(result.nextCursors);
      expect(failed.errors).toEqual([
        { projectId: "web", projectTitle: "web", message: "try again" },
      ]);
      const next = yield* service.list({ state: "open", cursors: failed.nextCursors });
      expect(next.entries.map((entry) => [entry.projectId, entry.key])).toEqual([["web", "4"]]);
      expect(next.nextCursors).toEqual({});
      expect(next.errors).toEqual([]);

      // The cursor belongs to the scope, not to the project whose spelling first read it.
      listed.length = 0;
      const through = yield* service.list({
        state: "open",
        projectId: "web-worktree" as ProjectId,
        cursors: result.nextCursors,
      });
      expect(listed).toEqual(["acme/web"]);
      expect(through.entries.map((entry) => entry.key)).toEqual(["4"]);
    }),
  );
});

describe("IssueService with a standalone tracker", () => {
  it.effect("rejects a URL from another workspace with the same team and issue key", () =>
    Effect.gen(function* () {
      const service = yield* makeService({
        projects: [project({ id: "web" })],
        trackers: [fakeStandaloneTracker()],
        bindings: { web: { tracker: LINEAR, scope: "ENG" } },
      });
      expect(
        yield* service.resolveUrl("https://linear.app/acme/issue/ENG-1/old-title"),
      ).toMatchObject({ key: "ENG-1", writable: true });
      const refused = yield* service
        .resolveUrl("https://linear.app/other-workspace/issue/ENG-1/old-title")
        .pipe(Effect.result);
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "IssueOperationError",
          operation: "resolveUrl",
          reason: "not-found",
          detail: "This issue URL does not belong to the connected workspace.",
        },
      });
    }),
  );

  it.effect("lists a bound project's standalone scope beside its git host and serves both", () =>
    Effect.gen(function* () {
      const listed: string[] = [];
      const record = (tracker: IssueTrackerKind): Partial<IssueTrackerApi> => ({
        listIssues: (input) =>
          Effect.sync(() => {
            listed.push(`${tracker} ${input.host} ${input.scope}`);
            return { items: [issue(tracker === LINEAR ? "ENG-1" : "1")], nextCursor: null };
          }),
      });
      const projects = [project({ id: "web", repository: "acme/web" }), project({ id: "notes" })];
      const trackers = [fakeTracker(record(GITHUB)), fakeStandaloneTracker(record(LINEAR))];
      const bound = yield* makeService({
        projects,
        trackers,
        bindings: { ["web" as ProjectId]: { tracker: LINEAR, scope: "ENG" } },
      });

      const result = yield* bound.list({ state: "open" });
      expect(listed.sort()).toEqual(["github github.com acme/web", "linear linear.app ENG"]);
      expect(result.entries.map((entry) => [entry.tracker, entry.scope, entry.key]).sort()).toEqual(
        [
          ["github", "acme/web", "1"],
          ["linear", "ENG", "ENG-1"],
        ],
      );
      expect(result.trackers.map((tracker) => [tracker.tracker, tracker.host]).sort()).toEqual([
        ["github", "github.com"],
        ["linear", "linear.app"],
      ]);
      expect(result.scopes).toContainEqual({
        projectId: "web",
        tracker: "linear",
        host: "linear.app",
        scope: "ENG",
      });
      // Narrowed to one project, both of its trackers are still read.
      listed.length = 0;
      yield* bound.list({ state: "open", projectId: "web" as ProjectId });
      expect(listed.sort()).toEqual(["github github.com acme/web", "linear linear.app ENG"]);
      // A reference picks the project's tracker by kind; both are the project's own, so writable.
      const linearRef = {
        projectId: "web" as ProjectId,
        tracker: LINEAR,
        scope: "ENG",
        key: "ENG-1",
      };
      expect(yield* bound.detail(linearRef)).toMatchObject({ host: "linear.app", writable: true });
      expect(
        yield* bound.detail({
          projectId: "web" as ProjectId,
          tracker: GITHUB,
          scope: "acme/web",
          key: "1",
        }),
      ).toMatchObject({ host: "github.com", writable: true });

      const resolved = yield* bound
        .resolveUrl("https://linear.app/acme/issue/ENG-1/issue-title", "web" as ProjectId)
        .pipe(Effect.result);
      expect(resolved).toMatchObject({
        _tag: "Success",
        success: {
          projectId: "web",
          tracker: LINEAR,
          host: "linear.app",
          scope: "ENG",
          key: "ENG-1",
          writable: true,
        },
      });

      // Unbound, the standalone scope is gone and its references are unsupported.
      listed.length = 0;
      const unbound = yield* makeService({ projects, trackers });
      const after = yield* unbound.list({ state: "open" });
      expect(listed).toEqual(["github github.com acme/web"]);
      expect(after.trackers.map((tracker) => tracker.tracker)).toEqual(["github"]);
      const refused = yield* Effect.flip(unbound.detail(linearRef));
      expect(refused).toMatchObject({
        _tag: "IssueUnavailableError",
        reason: "tracker-unsupported",
      });

      // A project with no remote at all can still be bound, and then has only the standalone one.
      const standaloneOnly = yield* makeService({
        projects,
        trackers,
        bindings: { ["notes" as ProjectId]: { tracker: LINEAR, scope: "OPS" } },
      });
      const notes = yield* standaloneOnly.list({ state: "open", projectId: "notes" as ProjectId });
      expect(notes.entries.map((entry) => [entry.projectId, entry.scope])).toEqual([
        ["notes", "OPS"],
      ]);

      // Bindings that cannot be read fail the listing; they are not taken for "none bound".
      const unreadable = yield* makeService({
        projects,
        trackers,
        bindingsFailure: new PersistenceSqlError({
          operation: "IssueTrackerBindingsRepository.list",
          detail: "disk I/O error",
        }),
      });
      expect(yield* Effect.flip(unreadable.list({ state: "open" }))).toMatchObject({
        _tag: "IssueOperationError",
        operation: "listProjects",
      });
    }),
  );
});
