import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { refineUnknownRemoteProvider } from "@t3tools/source-control-core/server/discovery";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import * as ForgejoIssueTracker from "@t3tools/source-control-forgejo/server/ForgejoIssueTracker";
import * as ForgejoSourceControlProvider from "@t3tools/source-control-forgejo/server/ForgejoSourceControlProvider";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as RateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as IssueTrackerHost from "@t3tools/issue-tracker-core/server/IssueTrackerHost";
import * as LinearApi from "@t3tools/issue-tracker-linear/server/LinearApi";
import * as LinearIssueTracker from "@t3tools/issue-tracker-linear/server/LinearIssueTracker";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubIssueTracker from "@t3tools/source-control-github/server/GitHubIssueTracker";
import {
  AuthOrchestrationReadScope,
  IssueTrackerKind,
  IssueUpdateInput,
  type IssueTrackerProjectBinding,
  type OrchestrationProjectShell,
  ProjectId,
  WS_METHODS,
  type IssueViewerPermissions,
  type IssueReactionContent,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
  type StandaloneIssueTrackerApi,
  type TrackerIssueDetail,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";
import * as ProcessRunner from "../processRunner.ts";

const GITHUB = IssueTrackerKind.make("github");
const LINEAR = IssueTrackerKind.make("linear");
const JIRA = IssueTrackerKind.make("jira");
const decodeUpdate = Schema.decodeEffect(IssueUpdateInput);
const permissions = {
  setState: true,
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
} satisfies IssueViewerPermissions;

/** A standalone tracker shaped like Linear: its own host, team keys for scopes, `ENG-1` keys. */
function fakeStandaloneTracker(
  overrides: Partial<IssueTrackerApi> = {},
): StandaloneIssueTrackerApi {
  return {
    ...fakeTracker({
      getViewer: () => Effect.succeed("usr_julius"),
      getIssue: (input) =>
        Effect.succeed({ ...issue(input.key), displayKey: input.key, viewer: "usr_julius" }),
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
    getViewerPermissions: () => Effect.succeed(permissions),
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
  readonly resolveRepository?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]["resolve"];
}) {
  return IssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
          list: Effect.sync(
            () =>
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
            Effect.succeed(Option.fromNullishOr(input.projects.find((p) => p.id === projectId))),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve:
            input.resolveRepository ??
            ((cwd) =>
              Effect.succeed(
                input.projects.find((project) => project.workspaceRoot === cwd)
                  ?.repositoryIdentity ?? null,
              )),
        }),
      ),
    ),
  );
}

describe("resolveGitHostBinding", () => {
  it.effect.each([
    { name: "SSH root", remote: "git@forgejo.test:acme/web.git", base: "https://forgejo.test" },
    {
      name: "HTTPS mount",
      remote: "https://forgejo.test:3000/mount/acme/web.git",
      base: "https://forgejo.test:3000/mount",
    },
    {
      name: "HTTPS case-sensitive mount",
      remote: "https://forgejo.test/Mount/Acme/Web.git",
      base: "https://forgejo.test/Mount",
    },
    {
      name: "SSH mount",
      remote: "git@forgejo.test:acme/web.git",
      base: "https://forgejo.test/mount",
    },
    {
      name: "SSH host alias",
      remote: "git@ssh.forgejo.test:acme/web.git",
      base: "https://forgejo.test/mount",
    },
  ])("uses the resolved Forgejo web binding: $name", ({ remote, base }) => {
    const native: { readonly path: string; readonly write: boolean }[] = [];
    let contextReads = 0;
    const repository = remote.includes("Acme/Web") ? "Acme/Web" : "acme/web";
    const url = `${base}/${repository}/issues/42`;
    return Effect.gen(function* () {
      const cli = yield* ForgejoCli.make;
      const tracker = yield* ForgejoIssueTracker.make.pipe(
        Effect.provideService(ForgejoCli.ForgejoCli, cli),
      );
      const provider = yield* ForgejoSourceControlProvider.make.pipe(
        Effect.provideService(ForgejoCli.ForgejoCli, cli),
      );
      const discovery = yield* ForgejoSourceControlProvider.makeDiscovery.pipe(
        Effect.provideService(ForgejoCli.ForgejoCli, cli),
      );
      const { process } = yield* SourceControlHost.SourceControlHost;
      const identities = yield* RepositoryIdentityResolver.make({
        refine: (identity) =>
          provider.refineRepositoryIdentity!({
            identity,
            resolveContext: (input) => {
              contextReads++;
              return refineUnknownRemoteProvider({
                specs: [discovery],
                process,
                cwd: input.cwd,
                context: input.context,
              });
            },
          }),
      }).pipe(
        Effect.provide(
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: (input) =>
              Effect.succeed({
                stdout: input.args.includes("--show-toplevel")
                  ? "/w/p"
                  : `origin\t${remote} (fetch)\n`,
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              }),
          }),
        ),
      );
      const identity = yield* identities.resolve("/w/p");
      expect(identity?.webUrl).toBe(`${base}/${repository}`);
      const service = yield* makeService({
        projects: [{ ...project({ id: "p" }), repositoryIdentity: identity }],
        trackers: [tracker],
        resolveRepository: identities.resolve,
      });
      const [binding] = yield* service.sources(ProjectId.make("p"));
      const web = new URL(`${base}/${repository}`);
      expect(contextReads).toBe(1);
      expect(native).toEqual([]);
      const ref = { projectId: ProjectId.make("p"), ...binding!, key: "42" };
      const detail = yield* service.detail(ref);
      expect(detail).toMatchObject({ url, writable: true });
      expect(native).toHaveLength(6);
      expect(contextReads).toBe(1);
      const resolved = yield* service.resolveUrl(
        `${base}/${repository.toLowerCase()}/issues/42`,
        ref.projectId,
      );
      expect(
        yield* service.resolveUrl(`${base}/${repository}/issues/42/summary`, ref.projectId),
      ).toEqual(resolved);
      expect(yield* service.resolveUrl(` ${base}/${repository}/issues/42 `, ref.projectId)).toEqual(
        resolved,
      );
      expect(native).toHaveLength(6);
      expect(contextReads).toBe(1);
      yield* service.setState({ ...resolved, state: "closed" });
      expect(binding).toEqual({
        tracker: IssueTrackerKind.make("forgejo"),
        host: web.host,
        scope: web.pathname.slice(1, -repository.length) + repository.toLowerCase(),
      });
      expect(resolved).toEqual({ ...ref, writable: true });
      expect(native.slice(6).map((call) => call.write)).toEqual([false, true]);
      expect(contextReads).toBe(2);
      expect(
        native.every((call) =>
          call.path.startsWith(`${web.pathname.slice(0, -repository.length)}api/v1/`),
        ),
      ).toBe(true);
      if (base.endsWith("/Mount")) {
        const aliasStart = native.length;
        yield* service.setState({ ...ref, scope: "Mount/ACME/WEB", state: "closed" });
        expect(native.slice(aliasStart).map((call) => call.write)).toEqual([false, true]);
        const before = native.length;
        const direct = yield* service
          .detail({ ...ref, scope: "mount/acme/web" })
          .pipe(Effect.result);
        expect(direct._tag).toBe("Failure");
        expect(native).toHaveLength(before);
        const foreignMount = yield* service.resolveUrl(
          "https://forgejo.test/mount/acme/web/issues/42",
          ref.projectId,
        );
        const write = yield* service
          .setState({ ...foreignMount, state: "closed" })
          .pipe(Effect.flip);
        expect({
          writable: foreignMount.writable,
          reason: write.reason,
          calls: native.slice(before),
        }).toEqual({ writable: false, reason: "read-only", calls: [] });
      }
      const foreign = yield* service.resolveUrl(`${base}/acme/other/issues/42`, ref.projectId);
      expect(foreign.writable).toBe(false);
      const before = native.length;
      const refused = yield* service.setState({ ...foreign, state: "closed" }).pipe(Effect.flip);
      expect(refused).toMatchObject({ reason: "read-only" });
      expect(native).toHaveLength(before);
      const unknownHost = yield* service
        .resolveUrl("https://other.test/acme/web/issues/42", ref.projectId)
        .pipe(Effect.result);
      expect(unknownHost._tag).toBe("Failure");
      expect(native).toHaveLength(before);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected HTTP")),
      ),
      Effect.provide(
        TestSourceControlHost.layer({
          process: {
            run: (input) => {
              if (input.command === "git")
                return Effect.succeed(
                  TestSourceControlHost.processOutput(`origin\t${remote} (fetch)\n`),
                );
              if (input.command !== "tea") return Effect.die(`Unexpected command ${input.command}`);
              if (input.args[0] === "login")
                return Effect.succeed(
                  TestSourceControlHost.processOutput(
                    JSON.stringify([
                      {
                        name: "fixture",
                        url: base,
                        ssh_host: remote.includes("ssh.forgejo")
                          ? "ssh.forgejo.test"
                          : "forgejo.test",
                        user: "alice",
                        default: "true",
                      },
                    ]),
                  ),
                );
              const endpoint = input.args.at(-1)!;
              const path = new URL(endpoint).pathname;
              native.push({ path, write: input.args.includes("PATCH") });
              const value = path.endsWith("/issues/42")
                ? {
                    number: 42,
                    title: "Issue",
                    html_url: url,
                    user: { login: "alice" },
                    state: "open",
                    body: "",
                    created_at: "2026-10-01T00:00:00Z",
                    updated_at: "2026-10-01T00:00:00Z",
                    comments: 0,
                  }
                : path.toLowerCase().endsWith("/repos/acme/web")
                  ? { full_name: repository, permissions: { push: true, admin: true } }
                  : path.endsWith("/user")
                    ? { login: "alice" }
                    : [];
              return Effect.succeed(
                TestSourceControlHost.processOutput(JSON.stringify(value), {
                  stderr: 'HTTP/1.1 200\nLink: <https://fixture.invalid>; rel="last"\n',
                }),
              );
            },
          },
        }),
      ),
    );
  });

  it.each([
    { host: "acme.visualstudio.com", repository: "platform/_git/repo", scope: "acme/platform" },
    {
      host: "acme.visualstudio.com",
      repository: "DefaultCollection/My%20Project/_git/repo",
      scope: "acme/My Project",
    },
    { host: "dev.azure.com", repository: "acme/My%20Project/_git/repo", scope: "acme/My Project" },
    {
      host: "dev.azure.com",
      repository: "acme/My%2520Project/_git/repo",
      scope: "acme/My%20Project",
    },
  ])(
    "resolves native Azure project scope from $host/$repository",
    ({ host, repository, scope }) => {
      const original = project({ id: "p", provider: "azure-devops", host, repository });
      const identity = structuredClone(original.repositoryIdentity);
      expect(IssueService.resolveGitHostBinding(original)).toEqual({
        tracker: "azure-devops",
        host,
        scope,
      });
      expect(original.repositoryIdentity).toEqual(identity);
    },
  );

  it.each([
    "acme/My%2FProject/_git/repo",
    "acme/My%5CProject/_git/repo",
    "acme/My%ZZProject/_git/repo",
    "Ac%2Fme/project/_git/repo",
  ])("refuses invalid Azure scope encoding in %s", (repository) => {
    expect(
      IssueService.resolveGitHostBinding(
        project({ id: "p", provider: "azure-devops", host: "dev.azure.com", repository }),
      ),
    ).toBeNull();
  });
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
  it.effect("forwards template catalog and selected-body flags without other native reads", () =>
    Effect.gen(function* () {
      expect(RPC_REQUIRED_SCOPES[WS_METHODS.issuesTemplates]).toBe(AuthOrchestrationReadScope);
      const calls: Parameters<NonNullable<IssueTrackerApi["listTemplates"]>>[0][] = [];
      const template = {
        key: "Bug",
        name: "Bug",
        about: "Report a bug",
        title: "",
        body: "Describe the bug",
        labels: [],
        assignees: [],
      };
      const tracker = fakeTracker({
        capabilities: { ...fakeTracker().capabilities, templates: true },
        listTemplates: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return {
              templates: [
                input.metadataOnly ? { ...template, body: "", contentDeferred: true } : template,
              ],
              blankIssuesEnabled: true,
            };
          }),
        getViewer: () => Effect.die("Unexpected viewer read"),
        getIssue: () => Effect.die("Unexpected issue read"),
        getViewerPermissions: () => Effect.die("Unexpected permissions read"),
      });
      const service = yield* makeService({
        projects: [project({ id: "p", repository: "acme/web" })],
        trackers: [tracker],
      });
      const flags = [
        {},
        { metadataOnly: false },
        { metadataOnly: true },
        { templateKey: "Bug" },
        { metadataOnly: false, templateKey: "Bug" },
      ];
      for (const selection of flags) {
        const result = yield* service.templates({
          projectId: ProjectId.make("p"),
          tracker: GITHUB,
          scope: "acme/web",
          ...selection,
        });
        expect(result.templates).toEqual([
          selection.metadataOnly ? { ...template, body: "", contentDeferred: true } : template,
        ]);
      }
      expect(calls).toEqual(
        flags.map((selection) => ({
          cwd: "/w/p",
          host: "github.com",
          scope: "acme/web",
          ...selection,
        })),
      );
    }),
  );

  it.effect("keeps a complete native label set through the update contract", () =>
    Effect.gen(function* () {
      const labels = Array.from({ length: 121 }, (_, index) => `label-${index}`);
      let written: ReadonlyArray<string> | undefined;
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            update: (input) =>
              Effect.sync(() => {
                written = input.labels;
              }),
          }),
        ],
      });
      const input = yield* decodeUpdate({
        projectId: ProjectId.make("web"),
        tracker: GITHUB,
        host: "github.com",
        scope: "acme/web",
        key: "1",
        labels,
      });
      yield* service.update(input);
      expect(written).toEqual(labels);
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

  it.effect("keeps tracker scopes and viewers separate when two trackers share a host", () =>
    Effect.gen(function* () {
      const host = "shared.example";
      const gitlab = IssueTrackerKind.make("gitlab");
      const readViewers: string[] = [];
      const listed: string[] = [];
      const projects = [
        project({ id: "gh", repository: "acme/web", host }),
        project({ id: "gl", repository: "acme/web", provider: "gitlab", host }),
      ];
      const service = yield* makeService({
        projects,
        trackers: [GITHUB, gitlab].map((kind) =>
          fakeTracker({
            kind,
            getViewer: () =>
              Effect.sync(() => {
                readViewers.push(kind);
                return kind + "-viewer";
              }),
            listIssues: (input) =>
              Effect.sync(() => {
                expect(input.viewer).toBe(kind + "-viewer");
                listed.push(kind);
                return { items: [issue("1")], nextCursor: "next" };
              }),
          }),
        ),
      });
      const result = yield* service.list({ state: "open" });
      expect(readViewers.toSorted()).toEqual(["github", "gitlab"]);
      expect(listed.toSorted()).toEqual(["github", "gitlab"]);
      expect(result.entries.map((entry) => entry.tracker).toSorted()).toEqual(["github", "gitlab"]);
      expect(
        result.trackers
          .map((summary) => [summary.tracker, summary.host, summary.projectCount])
          .toSorted(),
      ).toEqual([
        ["github", host, 1],
        ["gitlab", host, 1],
      ]);
      expect(result.viewers).toEqual({
        "github shared.example": "github-viewer",
        "gitlab shared.example": "gitlab-viewer",
      });
      expect(result.nextCursors).toEqual({
        "github shared.example acme/web": "next",
        "gitlab shared.example acme/web": "next",
      });
      yield* service.list({ state: "open", cursors: { "gitlab shared.example acme/web": "next" } });
      expect(listed).toHaveLength(3);
      expect(listed.at(-1)).toBe("gitlab");
      const narrowed = yield* service.list({ state: "open", projectId: ProjectId.make("gl") });
      expect(narrowed.nextCursors).toEqual({ "gitlab shared.example acme/web": "next" });
      expect(narrowed.viewers).toEqual({ "gitlab shared.example": "gitlab-viewer" });
      yield* service.list({ state: "open", cursors: narrowed.nextCursors });
      expect(listed.at(-1)).toBe("gitlab");
      expect(listed).toHaveLength(5);
      for (const projectId of [undefined, ProjectId.make("gl")]) {
        const failure = yield* Effect.flip(
          service.list({
            state: "open",
            projectId,
            cursors: { "shared.example acme/web": "next" },
          }),
        );
        expect(failure).toMatchObject({ _tag: "IssueOperationError", operation: "list" });
      }
      expect(listed).toHaveLength(5);
      expect(readViewers).toHaveLength(5);
      const unsupported = yield* makeService({
        projects,
        trackers: [fakeTracker()],
      });
      const unavailable = yield* unsupported.list({ state: "open" });
      expect(unavailable.trackers.map(({ tracker, configured }) => [tracker, configured])).toEqual([
        ["github", true],
        ["gitlab", false],
      ]);
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
      expect(result.nextCursors).toEqual({ "github github.com acme/web": "next" });
      expect(result.errors).toEqual([
        {
          projectId: "api",
          projectTitle: "api",
          tracker: GITHUB,
          host: "github.com",
          message: "boom",
        },
      ]);
      expect(result.viewers).toEqual({ "github github.com": "julius" });
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

describe("IssueService with a standalone tracker", () => {
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
    }),
  );
});

describe("IssueService write permissions", () => {
  it.effect.each([
    { role: null, status: 200, succeeds: true, writes: 1 },
    { role: null, status: 403, succeeds: false, writes: 1 },
    { role: "READ", status: 200, succeeds: false, writes: 0 },
    { role: "TRIAGE", status: 200, succeeds: true, writes: 1 },
  ])("keeps native GitHub metadata authorization for $role/$status", (testCase) =>
    Effect.gen(function* () {
      let reads = 0;
      const writes: GitHubApi.GitHubRestInput[] = [];
      const driver = yield* GitHubIssueTracker.make.pipe(
        Effect.provide(
          Layer.mock(GitHubApi.GitHubApi)({
            graphql: ({ host, variables }) =>
              Effect.sync(() => {
                reads += 1;
                expect(host).toBe("github.com");
                expect(variables).toEqual({ owner: "acme", name: "web", number: 42 });
                return JSON.stringify({
                  data: {
                    repository: {
                      viewerPermission: testCase.role,
                      issue: { viewerCanUpdate: false },
                    },
                  },
                });
              }),
            rest: (request) =>
              Effect.sync(() => {
                writes.push(request);
              }).pipe(
                Effect.andThen(
                  testCase.status === 403
                    ? Effect.fail(
                        new GitHubApi.GitHubApiResponseError({
                          host: "github.com",
                          operation: "update",
                          status: 403,
                        }),
                      )
                    : Effect.succeed({
                        status: 200,
                        headers: {},
                        truncated: false,
                        invalidUtf8: false,
                        body: JSON.stringify({
                          labels: [{ name: "bug", color: "000000" }],
                          assignees: [{ login: "octocat" }],
                        }),
                      }),
                ),
              ),
          }),
        ),
      );
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [driver],
      });
      const update = service.update({
        projectId: ProjectId.make("web"),
        tracker: GITHUB,
        scope: "acme/web",
        key: "42",
        labels: ["bug"],
        assignees: ["octocat"],
      });
      if (testCase.succeeds) yield* update;
      else {
        const error = yield* Effect.flip(update);
        expect(error._tag).toBe("IssueOperationError");
        if (testCase.status === 403)
          expect(error).toMatchObject({
            detail: expect.stringContaining("403"),
            cause: { cause: { _tag: "GitHubApiResponseError", status: 403 } },
          });
      }
      expect(reads).toBe(1);
      expect(writes).toHaveLength(testCase.writes);
      if (testCase.writes > 0)
        expect(writes[0]).toMatchObject({
          host: "github.com",
          method: "PATCH",
          path: "repos/acme/web/issues/42",
          body: { labels: ["bug"], assignees: ["octocat"] },
        });
    }),
  );

  it.effect.each([
    { field: "edit" as const, input: { title: "Changed" } },
    { field: "edit" as const, input: { body: "Changed" } },
    { field: "labels" as const, input: { labels: [] } },
    { field: "assignees" as const, input: { assignees: [] } },
    { field: "labels" as const, input: { title: "Changed", labels: [] } },
    { field: "assignees" as const, input: { labels: [], assignees: [] } },
  ])("checks fresh permission before updating $field", ({ field, input }) =>
    Effect.gen(function* () {
      let reads = 0;
      let writes = 0;
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            getViewerPermissions: () =>
              Effect.sync(() => {
                reads++;
                return { ...permissions, [field]: false };
              }),
            update: () =>
              Effect.sync(() => {
                writes++;
              }),
          }),
        ],
      });
      const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };
      expect((yield* service.detail(ref)).viewerPermissions[field]).toBe(true);
      const denied = yield* Effect.flip(service.update({ ...ref, ...input }));
      expect(denied._tag).toBe("IssueOperationError");
      expect(reads).toBe(1);
      expect(writes).toBe(0);
    }),
  );

  it.effect.each(["comment", "setState"] as const)(
    "checks fresh %s permission before writing",
    (operation) =>
      Effect.gen(function* () {
        let reads = 0;
        let writes = 0;
        const write = () =>
          Effect.sync(() => {
            writes++;
          });
        const service = yield* makeService({
          projects: [project({ id: "web", repository: "acme/web" })],
          trackers: [
            fakeTracker({
              getViewerPermissions: () =>
                Effect.sync(() => {
                  reads++;
                  return { ...permissions, [operation]: false };
                }),
              comment: write,
              setState: write,
            }),
          ],
        });
        const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };
        const denied = yield* Effect.flip(
          operation === "comment"
            ? service.comment({ ...ref, body: "Hello" })
            : service.setState({ ...ref, state: "closed" }),
        );
        expect(denied._tag).toBe("IssueOperationError");
        expect(reads).toBe(1);
        expect(writes).toBe(0);
      }),
  );

  it.effect("checks an update once and only needs permissions for its present fields", () =>
    Effect.gen(function* () {
      let reads = 0;
      let writes = 0;
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            getViewerPermissions: () =>
              Effect.sync(() => {
                reads++;
                return { ...permissions, edit: false, comment: false, setState: false };
              }),
            update: () =>
              Effect.sync(() => {
                writes++;
              }),
          }),
        ],
      });
      yield* service.update({
        projectId: "web" as ProjectId,
        tracker: GITHUB,
        scope: "acme/web",
        key: "1",
        labels: [],
        assignees: [],
      });
      expect(reads).toBe(1);
      expect(writes).toBe(1);
    }),
  );

  it.effect("preserves native permission probe failures without writing", () =>
    Effect.gen(function* () {
      let writes = 0;
      const error = new IssueTrackerError({
        tracker: GITHUB,
        operation: "getViewerPermissions",
        reason: "rate-limited",
        detail: "Try again later.",
        retryAt: 1234,
      });
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            getViewerPermissions: () => Effect.fail(error),
            update: () =>
              Effect.sync(() => {
                writes++;
              }),
          }),
        ],
      });
      const denied = yield* Effect.flip(
        service.update({
          projectId: "web" as ProjectId,
          tracker: GITHUB,
          scope: "acme/web",
          key: "1",
          title: "Changed",
        }),
      );
      expect(denied).toMatchObject({
        _tag: "IssueOperationError",
        reason: "rate-limited",
        detail: error.detail,
        retryAt: 1234,
        cause: error,
      });
      expect(writes).toBe(0);
    }),
  );

  it.effect("does not write through a standalone binding changed during permission lookup", () =>
    Effect.gen(function* () {
      let writes = 0;
      const bindings: Record<string, IssueTrackerProjectBinding> = {
        web: { tracker: LINEAR, scope: "ENG" },
      };
      const service = yield* makeService({
        projects: [project({ id: "web" })],
        bindings,
        trackers: [
          fakeStandaloneTracker({
            getViewerPermissions: () =>
              Effect.sync(() => {
                bindings.web = { tracker: LINEAR, scope: "OPS" };
                return permissions;
              }),
            update: () =>
              Effect.sync(() => {
                writes++;
              }),
          }),
        ],
      });
      const denied = yield* Effect.flip(
        service.update({
          projectId: "web" as ProjectId,
          tracker: LINEAR,
          scope: "ENG",
          key: "ENG-1",
          title: "Changed",
        }),
      );
      expect(denied).toMatchObject({ _tag: "IssueOperationError", reason: "read-only" });
      expect(writes).toBe(0);
    }),
  );
});

it.effect("shares the viewer probe per host within each list call", () =>
  Effect.gen(function* () {
    let reads = 0;
    const service = yield* makeService({
      projects: [
        project({ id: "web", repository: "acme/web" }),
        project({ id: "api", repository: "acme/api" }),
      ],
      trackers: [
        fakeTracker({
          getViewer: () =>
            Effect.yieldNow.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  reads++;
                  return "julius";
                }),
              ),
            ),
        }),
      ],
    });
    yield* service.list({ state: "open" });
    expect(reads).toBe(1);
    yield* service.list({ state: "open" });
    expect(reads).toBe(2);
  }),
);

it.effect.each(["forgejo", "github", "plugin"])(
  "deduplicates %s viewers for same-instance repositories and worktrees",
  (kind) =>
    Effect.gen(function* () {
      const tracker = IssueTrackerKind.make(kind);
      const host = "same.example";
      let viewerReads = 0;
      let issueReads = 0;
      const api = fakeTracker({
        kind: tracker,
        getViewer: () =>
          Effect.sync(() => {
            viewerReads++;
            return "alice";
          }),
        listIssues: (input) =>
          Effect.sync(() => {
            issueReads++;
            expect(input.viewer).toBe("alice");
            return { items: [], nextCursor: null };
          }),
      });
      const projects = [
        { id: "web", repository: "Acme/Web" },
        { id: "api", repository: "acme/Api" },
        { id: "worktree", repository: kind === "forgejo" ? "ACME/WEB" : "Acme/Web" },
      ].map((input) => {
        const shell = project({ ...input, host, provider: kind });
        return kind === "forgejo"
          ? {
              ...shell,
              repositoryIdentity: {
                ...shell.repositoryIdentity!,
                webUrl: `https://${host}/Mount/${input.repository}`,
              },
            }
          : shell;
      });
      const service = yield* makeService({ projects, trackers: [api] });
      const result = yield* service.list({ state: "open", involvement: "assigned" });
      expect(result.errors).toEqual([]);
      expect({ viewerReads, issueReads }).toEqual({ viewerReads: 1, issueReads: 2 });
      expect(result.viewers).toEqual(
        kind === "forgejo"
          ? {
              "forgejo same.example": "alice",
              "forgejo same.example Mount/acme/web": "alice",
              "forgejo same.example Mount/acme/api": "alice",
            }
          : { [`${kind} ${host}`]: "alice" },
      );
    }),
);

it.effect("returns project sources without reading a tracker API", () =>
  Effect.gen(function* () {
    const unused = () => Effect.die("Sources must not probe providers");
    const service = yield* makeService({
      projects: [project({ id: "web", repository: "acme/web" })],
      bindings: { web: { tracker: LINEAR, scope: "ENG" } },
      trackers: [fakeTracker({ getViewer: unused }), fakeStandaloneTracker({ getViewer: unused })],
    });
    expect(yield* service.sources("web" as ProjectId)).toEqual([
      { tracker: GITHUB, host: "github.com", scope: "acme/web" },
      { tracker: LINEAR, host: "linear.app", scope: "ENG" },
    ]);
  }),
);

it.effect("refreshes a cached repository identity before a permitted write", () =>
  Effect.gen(function* () {
    let refreshes = 0;
    let writes = 0;
    const service = yield* makeService({
      projects: [project({ id: "web", repository: "acme/web" })],
      resolveRepository: (_cwd, options) =>
        Effect.sync(() => {
          expect(options?.refresh).toBe(true);
          refreshes++;
          return project({ id: "web", repository: "acme/api" }).repositoryIdentity ?? null;
        }),
      trackers: [
        fakeTracker({
          update: () =>
            Effect.sync(() => {
              writes++;
            }),
        }),
      ],
    });
    const denied = yield* Effect.flip(
      service.update({
        projectId: "web" as ProjectId,
        tracker: GITHUB,
        scope: "acme/web",
        key: "1",
        title: "Changed",
      }),
    );
    expect(denied).toMatchObject({ _tag: "IssueOperationError", reason: "read-only" });
    expect(refreshes).toBe(1);
    expect(writes).toBe(0);
  }),
);

it.effect("uses a standalone binding's verified site and refuses references to another site", () =>
  Effect.gen(function* () {
    let reads = 0;
    const base = fakeStandaloneTracker({
      getIssue: (input) =>
        Effect.sync(() => {
          reads++;
          expect(input.host).toBe("example.atlassian.net");
          return issue(input.key);
        }),
    });
    const api: StandaloneIssueTrackerApi = {
      ...base,
      kind: JIRA,
      standalone: { ...base.standalone, tracker: JIRA, host: null },
      probeCredential: () => Effect.die("Source resolution must not probe credentials"),
    };
    const service = yield* makeService({
      projects: [project({ id: "web" })],
      trackers: [api],
      bindings: { web: { tracker: JIRA, scope: "ENG", host: "example.atlassian.net" } },
    });
    expect(yield* service.sources("web" as ProjectId)).toEqual([
      { tracker: JIRA, scope: "ENG", host: "example.atlassian.net" },
    ]);
    const ref = { projectId: "web" as ProjectId, tracker: JIRA, scope: "ENG", key: "ENG-1" };
    expect(yield* service.detail({ ...ref, host: "example.atlassian.net" })).toMatchObject({
      writable: true,
    });
    expect(
      yield* Effect.flip(service.detail({ ...ref, host: "other.atlassian.net" })),
    ).toMatchObject({ _tag: "IssueUnavailableError" });
    expect(reads).toBe(1);
    const missingHost = yield* makeService({
      projects: [project({ id: "web" })],
      trackers: [api],
      bindings: { web: { tracker: JIRA, scope: "ENG" } },
    });
    expect(yield* missingHost.sources("web" as ProjectId)).toEqual([]);
  }),
);

it.effect(
  "offers and forwards a native issue type without requiring label or assignee support",
  () =>
    Effect.gen(function* () {
      const base = fakeTracker();
      let selected: string | undefined;
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            capabilities: {
              ...base.capabilities,
              labels: false,
              assignees: false,
              createIssueTypes: true,
            },
            listCandidates: () =>
              Effect.succeed({
                labels: [],
                assignees: [],
                issueTypes: [{ id: "10001", name: "Bug" }],
                truncated: false,
              }),
            create: (input) =>
              Effect.sync(() => {
                selected = input.issueType;
                return { key: "1", displayKey: "#1", url: "https://github.com/acme/web/issues/1" };
              }),
          }),
        ],
      });
      const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web" };
      expect((yield* service.candidates(ref)).issueTypes).toEqual([{ id: "10001", name: "Bug" }]);
      yield* service.create({
        ...ref,
        title: "Fix",
        body: "",
        labels: [],
        assignees: [],
        issueType: "10001",
      });
      expect(selected).toBe("10001");
    }),
);

it.effect("refuses a selected issue type when the tracker does not support it", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [project({ id: "web", repository: "acme/web" })],
      trackers: [
        fakeTracker({ create: () => Effect.die("Unsupported type must not reach create") }),
      ],
    });
    const error = yield* Effect.flip(
      service.create({
        projectId: "web" as ProjectId,
        tracker: GITHUB,
        scope: "acme/web",
        title: "Fix",
        body: "",
        labels: [],
        assignees: [],
        issueType: "10001",
      }),
    );
    expect(error).toMatchObject({ _tag: "IssueOperationError" });
  }),
);

it.effect(
  "returns empty source facts and attributes failures to the actual tracker without extra reads",
  () =>
    Effect.gen(function* () {
      let viewerReads = 0;
      let listReads = 0;
      const api = fakeStandaloneTracker({
        getViewer: () =>
          Effect.sync(() => {
            viewerReads++;
            return "native-1";
          }),
        listIssues: () =>
          Effect.sync(() => {
            listReads++;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new IssueTrackerError({
                  tracker: LINEAR,
                  operation: "list",
                  reason: "failed",
                  detail: "Team unavailable.",
                }),
              ),
            ),
          ),
      });
      const service = yield* makeService({
        projects: [project({ id: "web" })],
        trackers: [api],
        bindings: { web: { tracker: LINEAR, scope: "ENG" } },
      });
      const result = yield* service.list({ state: "open" });
      expect(result.entries).toEqual([]);
      expect(result.sources).toEqual([
        {
          projectId: "web",
          projectTitle: "web",
          tracker: LINEAR,
          host: "linear.app",
          scope: "ENG",
          capabilities: api.capabilities,
        },
      ]);
      expect(result.errors).toEqual([
        {
          projectId: "web",
          projectTitle: "web",
          tracker: LINEAR,
          host: "linear.app",
          message: "Team unavailable.",
        },
      ]);
      expect(viewerReads).toBe(1);
      expect(listReads).toBe(1);
    }),
);

it.effect(
  "refuses unsupported involvement before any native read while keeping older capabilities",
  () =>
    Effect.gen(function* () {
      for (const declared of [true, false]) {
        let reads = 0;
        const base = fakeTracker();
        const service = yield* makeService({
          projects: [project({ id: "web", repository: "acme/web" })],
          trackers: [
            fakeTracker({
              capabilities: {
                ...base.capabilities,
                ...(declared ? { involvements: ["all"] as const } : {}),
              },
              getViewer: () =>
                Effect.sync(() => {
                  reads++;
                  return "Alex";
                }),
              listIssues: () =>
                Effect.sync(() => {
                  reads++;
                  return { items: [], nextCursor: null };
                }),
            }),
          ],
        });
        const result = yield* service.list({ state: "open", involvement: "mentioned" });
        expect(reads).toBe(declared ? 0 : 2);
        expect(result.errors.length).toBe(declared ? 1 : 0);
        if (declared)
          expect(result.errors[0]).toMatchObject({ tracker: GITHUB, host: "github.com" });
      }
    }),
);

it.effect.each([
  { subjectId: undefined, content: "heart" },
  { subjectId: "12", content: "rocket" },
  { subjectId: "12", content: "eyes" },
] satisfies ReadonlyArray<{ subjectId: string | undefined; content: IssueReactionContent }>)(
  "rejects unsupported reaction $content on $subjectId before native reads",
  ({ subjectId, content }) =>
    Effect.gen(function* () {
      const azure = IssueTrackerKind.make("azure-devops");
      const base = fakeTracker();
      const service = yield* makeService({
        projects: [
          project({
            id: "web",
            provider: azure,
            host: "dev.azure.com",
            repository: "acme/Web App/_git/web",
          }),
        ],
        resolveRepository: () =>
          Effect.die("Unsupported reactions must not refresh the repository"),
        trackers: [
          fakeTracker({
            kind: azure,
            capabilities: {
              ...base.capabilities,
              reactions: false,
              commentReactions: true,
              reactionContents: [
                "thumbs-up",
                "thumbs-down",
                "heart",
                "hooray",
                "laugh",
                "confused",
              ],
            },
            getViewer: () => Effect.die("Unsupported reactions must not read the viewer"),
            getIssue: () => Effect.die("Unsupported reactions must not read the issue"),
            getViewerPermissions: () =>
              Effect.die("Unsupported reactions must not read permissions"),
            setReaction: () => Effect.die("Unsupported reactions must not write"),
          }),
        ],
      });
      const refused = yield* Effect.flip(
        service.react({
          projectId: "web" as ProjectId,
          tracker: azure,
          scope: "acme/Web App",
          key: "7",
          subjectId,
          content,
          reacted: true,
        }),
      );
      expect(refused).toMatchObject({
        _tag: "IssueOperationError",
        operation: "react",
        detail: expect.stringContaining("does not support"),
      });
    }),
);

it.effect.each([
  { reactions: false, commentReactions: true, reactionContents: ["heart"] },
  { reactions: true },
] as const)("writes supported comment reactions with one repository refresh", (capabilities) =>
  Effect.gen(function* () {
    const azure = IssueTrackerKind.make("azure-devops");
    const shell = project({
      id: "web",
      provider: azure,
      host: "dev.azure.com",
      repository: "acme/Web App/_git/web",
    });
    let refreshes = 0;
    const writes: unknown[] = [];
    const base = fakeTracker();
    const service = yield* makeService({
      projects: [shell],
      resolveRepository: (_cwd, options) =>
        Effect.sync(() => {
          expect(options?.refresh).toBe(true);
          refreshes++;
          return shell.repositoryIdentity ?? null;
        }),
      trackers: [
        fakeTracker({
          kind: azure,
          capabilities: { ...base.capabilities, ...capabilities },
          getViewer: () => Effect.die("Reactions must not read the viewer"),
          getIssue: () => Effect.die("Reactions must not read the issue"),
          getViewerPermissions: () => Effect.die("Reactions must not read permissions"),
          setReaction: (input) =>
            Effect.sync(() => {
              writes.push(input);
            }),
        }),
      ],
    });
    yield* service.react({
      projectId: "web" as ProjectId,
      tracker: azure,
      scope: "acme/Web App",
      key: "7",
      subjectId: "12",
      content: "heart",
      reacted: false,
    });
    expect(refreshes).toBe(1);
    expect(writes).toEqual([
      {
        cwd: "/w/web",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
        subjectId: "12",
        content: "heart",
        reacted: false,
      },
    ]);
  }),
);

it.effect("passes Azure custom states to the native writer without reading detail", () =>
  Effect.gen(function* () {
    const azure = IssueTrackerKind.make("azure-devops");
    const shell = project({
      id: "web",
      provider: azure,
      host: "dev.azure.com",
      repository: "acme/Web App/_git/web",
    });
    let permissionReads = 0;
    let refreshes = 0;
    const writes: unknown[] = [];
    const service = yield* makeService({
      projects: [shell],
      resolveRepository: (_cwd, options) =>
        Effect.sync(() => {
          expect(options?.refresh).toBe(true);
          refreshes++;
          return shell.repositoryIdentity ?? null;
        }),
      trackers: [
        fakeTracker({
          kind: azure,
          getIssue: () => Effect.die("State writes must not read detail"),
          getViewer: () => Effect.die("State writes must not read the viewer"),
          getViewerPermissions: () =>
            Effect.sync(() => {
              permissionReads++;
              return permissions;
            }),
          setState: (input) =>
            Effect.sync(() => {
              writes.push(input);
            }),
        }),
      ],
    });
    const ref = {
      projectId: "web" as ProjectId,
      tracker: azure,
      host: "dev.azure.com",
      scope: "acme/Web App",
      key: "7",
    };
    yield* service.setState({ ...ref, state: "Shipped" });
    expect(writes).toEqual([
      {
        cwd: "/w/web",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
        state: "Shipped",
        closeReason: undefined,
      },
    ]);
    expect(permissionReads).toBe(1);
    expect(refreshes).toBe(1);
    const refused = yield* Effect.flip(
      service.setState({ ...ref, state: "Shipped", closeReason: "completed" }),
    );
    expect(refused).toMatchObject({
      _tag: "IssueOperationError",
      detail: expect.stringContaining('the close reason "completed"'),
    });
    expect(writes).toHaveLength(1);
    expect(permissionReads).toBe(1);
    expect(refreshes).toBe(1);
  }),
);

it.effect("keeps non-Azure unknown states blocked before provider reads", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [project({ id: "web", repository: "acme/web" })],
      trackers: [
        fakeTracker({
          getViewerPermissions: () => Effect.die("Unknown states must not read permissions"),
          getIssue: () => Effect.die("Unknown states must not read detail"),
          setState: () => Effect.die("Unknown states must not write"),
        }),
      ],
    });
    const refused = yield* Effect.flip(
      service.setState({
        projectId: "web" as ProjectId,
        tracker: GITHUB,
        scope: "acme/web",
        key: "7",
        state: "Shipped",
      }),
    );
    expect(refused).toMatchObject({
      _tag: "IssueOperationError",
      operation: "setState",
      detail: expect.stringContaining('the state "Shipped"'),
    });
  }),
);

it.effect.each(["create", "react"] as const)(
  "refreshes cached repository ownership before %s",
  (operation) =>
    Effect.gen(function* () {
      let writes = 0;
      let refreshes = 0;
      const base = fakeTracker();
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        resolveRepository: (_cwd, options) =>
          Effect.sync(() => {
            expect(options?.refresh).toBe(true);
            refreshes++;
            return project({ id: "web", repository: "acme/api" }).repositoryIdentity ?? null;
          }),
        trackers: [
          fakeTracker({
            capabilities: { ...base.capabilities, reactions: true },
            create: () =>
              Effect.sync(() => {
                writes++;
                return { key: "2", displayKey: "#2", url: issue("2").url };
              }),
            setReaction: () =>
              Effect.sync(() => {
                writes++;
              }),
          }),
        ],
      });
      const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };
      const denied = yield* Effect.flip(
        operation === "create"
          ? service.create({ ...ref, title: "New", body: "", labels: [], assignees: [] })
          : service.react({ ...ref, content: "heart", reacted: true }),
      );
      expect(denied).toMatchObject({ _tag: "IssueOperationError", reason: "read-only" });
      expect(refreshes).toBe(1);
      expect(writes).toBe(0);
    }),
);

it.effect.each(["create", "update"] as const)(
  "rejects too many assignees before native %s calls",
  (operation) =>
    Effect.gen(function* () {
      let reads = 0;
      let writes = 0;
      const base = fakeTracker();
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            capabilities: { ...base.capabilities, maxAssignees: 1 },
            getViewerPermissions: () =>
              Effect.sync(() => {
                reads++;
                return permissions;
              }),
            create: () =>
              Effect.sync(() => {
                writes++;
                return { key: "2", displayKey: "#2", url: issue("2").url };
              }),
            update: () =>
              Effect.sync(() => {
                writes++;
              }),
          }),
        ],
      });
      const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };
      const denied = yield* Effect.flip(
        operation === "create"
          ? service.create({
              ...ref,
              title: "New",
              body: "",
              labels: [],
              assignees: ["alice", "bob"],
            })
          : service.update({ ...ref, assignees: ["alice", "bob"] }),
      );
      expect(denied._tag).toBe("IssueOperationError");
      expect(reads).toBe(0);
      expect(writes).toBe(0);
    }),
);

it.effect.each([{ assignees: [] }, { assignees: ["alice"] }])(
  "preserves valid assignee arrays, including clear: $assignees",
  ({ assignees }) =>
    Effect.gen(function* () {
      const written: ReadonlyArray<string>[] = [];
      const base = fakeTracker();
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            capabilities: { ...base.capabilities, maxAssignees: 1 },
            create: (input) =>
              Effect.sync(() => {
                written.push(input.assignees);
                return { key: "2", displayKey: "#2", url: issue("2").url };
              }),
            update: (input) =>
              Effect.sync(() => {
                written.push(input.assignees ?? []);
              }),
          }),
        ],
      });
      const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };
      yield* service.create({ ...ref, title: "New", body: "", labels: [], assignees });
      yield* service.update({ ...ref, assignees });
      expect(written).toEqual([assignees, assignees]);
    }),
);

it.effect("resolves a canonical Linear scope without an extra issue read", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const service = yield* makeService({
      projects: [project({ id: "legacy" }), project({ id: "other" }), project({ id: "web" })],
      trackers: [
        fakeStandaloneTracker({
          listIssues: () => Effect.die("URL resolution must not list issues"),
          getIssue: (input) =>
            Effect.sync(() => {
              calls.push(`read ${input.scope}`);
              return { ...issue(input.key), url: "https://linear.app/acme/issue/ENG-123/title" };
            }),
          comment: (input) =>
            Effect.sync(() => {
              calls.push(`comment ${input.scope}`);
            }),
          setState: (input) =>
            Effect.sync(() => {
              calls.push(`state ${input.scope}`);
            }),
        }),
      ],
      bindings: {
        legacy: { tracker: LINEAR, scope: "ENG" },
        other: { tracker: LINEAR, scope: "other/ENG" },
        web: { tracker: LINEAR, scope: "acme/ENG" },
      },
    });
    const ref = yield* service.resolveUrl(
      "https://linear.app/Acme/issue/ENG-123/title",
      ProjectId.make("legacy"),
    );
    expect(ref).toEqual({
      projectId: "web",
      tracker: LINEAR,
      host: "linear.app",
      scope: "acme/ENG",
      key: "ENG-123",
      writable: true,
    });
    expect(calls).toEqual([]);
    expect(yield* service.detail(ref)).toMatchObject({ writable: true, scope: "acme/ENG" });
    yield* service.comment({ ...ref, body: "Hello" });
    yield* service.setState({ ...ref, state: "closed" });
    expect(calls).toEqual(["read acme/ENG", "comment acme/ENG", "state acme/ENG"]);
  }),
);

it.effect(
  "rejects stale Linear refs after a canonical workspace binding replaces a bare team",
  () =>
    Effect.gen(function* () {
      const service = yield* makeService({
        projects: [project({ id: "web" })],
        trackers: [
          fakeStandaloneTracker({
            getIssue: () => Effect.die("Stale refs must not read issues"),
            getComments: () => Effect.die("Stale refs must not read comments"),
            getViewerPermissions: () => Effect.die("Stale refs must not read permissions"),
            comment: () => Effect.die("Stale refs must not write comments"),
          }),
        ],
        bindings: { web: { tracker: LINEAR, scope: "new-workspace/ENG" } },
      });
      for (const scope of ["ENG", "old-workspace/ENG"]) {
        const ref = { projectId: ProjectId.make("web"), tracker: LINEAR, scope, key: "ENG-123" };
        for (const operation of [
          service.detail(ref),
          service.comments({ ...ref, cursor: "next" }),
          service.comment({ ...ref, body: "Hello" }),
        ]) {
          expect(yield* Effect.flip(operation)).toMatchObject({ _tag: "IssueUnavailableError" });
        }
      }
      expect(
        yield* Effect.flip(service.resolveUrl("https://linear.app/old-workspace/issue/ENG-123")),
      ).toMatchObject({ _tag: "IssueUnavailableError" });
    }),
);

it.effect("resolves another Linear team's URL in the bound workspace read-only", () =>
  Effect.gen(function* () {
    const reads: string[] = [];
    const service = yield* makeService({
      projects: [project({ id: "web" })],
      trackers: [
        fakeStandaloneTracker({
          getIssue: (input) => {
            expect(input.scope.toLowerCase()).toBe("acme/qa");
            reads.push(input.scope);
            return Effect.succeed(issue(input.key));
          },
          getViewerPermissions: () => Effect.die("Foreign team writes must not read permissions"),
          comment: () => Effect.die("Foreign team must not write comments"),
        }),
      ],
      bindings: { web: { tracker: LINEAR, scope: "acme/ENG" } },
    });
    const ref = {
      projectId: ProjectId.make("web"),
      tracker: LINEAR,
      scope: "Acme/QA",
      key: "QA-123",
    };
    expect(yield* service.detail(ref)).toMatchObject({
      writable: false,
    });
    expect(yield* Effect.flip(service.comment({ ...ref, body: "Hello" }))).toMatchObject({
      _tag: "IssueOperationError",
      reason: "read-only",
    });
    const resolved = yield* service.resolveUrl("https://linear.app/acme/issue/QA-123/title");
    expect(resolved).toEqual({
      projectId: "web",
      tracker: LINEAR,
      host: "linear.app",
      scope: "acme/qa",
      key: "QA-123",
      writable: false,
    });
    expect(reads).toEqual(["Acme/QA"]);
    expect(yield* service.detail(resolved)).toMatchObject({ writable: false });
    expect(yield* Effect.flip(service.comment({ ...resolved, body: "Hello" }))).toMatchObject({
      _tag: "IssueOperationError",
      reason: "read-only",
    });
    expect(
      yield* Effect.flip(service.resolveUrl("https://linear.app/other-workspace/issue/QA-123")),
    ).toMatchObject({ _tag: "IssueUnavailableError" });
    expect(reads).toEqual(["Acme/QA", "acme/qa"]);
  }),
);

it.effect("resolves a legacy Linear team binding and verifies the native workspace", () =>
  Effect.gen(function* () {
    let reads = 0;
    const writes: string[] = [];
    const api = fakeStandaloneTracker({
      listIssues: () => Effect.die("URL resolution must not list issues"),
      getIssue: (input) =>
        Effect.sync(() => {
          reads++;
          expect(input.scope).toBe("ENG");
          return { ...issue(input.key), url: "https://linear.app/acme/issue/ENG-123/native-title" };
        }),
      comment: (input) =>
        Effect.sync(() => {
          writes.push(`comment ${input.scope} ${input.key}`);
        }),
      setState: (input) =>
        Effect.sync(() => {
          writes.push(`state ${input.scope} ${input.key}`);
        }),
    });
    const service = yield* makeService({
      projects: [project({ id: "other" }), project({ id: "web" })],
      trackers: [api],
      bindings: { other: { tracker: LINEAR, scope: "QA" }, web: { tracker: LINEAR, scope: "ENG" } },
    });
    const ref = yield* service.resolveUrl(
      "https://linear.app/acme/issue/ENG-123/older-title",
      ProjectId.make("other"),
    );
    expect(ref).toEqual({
      projectId: "web",
      tracker: LINEAR,
      host: "linear.app",
      scope: "ENG",
      key: "ENG-123",
      writable: true,
    });
    yield* service.comment({ ...ref, body: "Hello" });
    yield* service.setState({ ...ref, state: "closed" });
    expect(writes).toEqual(["comment ENG ENG-123", "state ENG ENG-123"]);
    expect(
      yield* Effect.flip(
        service.resolveUrl("https://linear.app/another-workspace/issue/ENG-123/title"),
      ),
    ).toMatchObject({ _tag: "IssueOperationError", reason: "not-found" });
    expect(reads).toBe(2);
  }),
);

it.effect(
  "resolves Jira URL refs with same-site foreign project reads and writes only on the bound project",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const writes: string[] = [];
      const base = fakeStandaloneTracker({
        listIssues: () => Effect.die("URL resolution must not list issues"),
        getIssue: (input) =>
          Effect.sync(() => {
            reads++;
            expect(input.host).toBe("tenant.atlassian.net");
            expect(input.scope).toBe(input.key.split("-")[0]);
            return { ...issue(input.key), url: `https://tenant.atlassian.net/browse/${input.key}` };
          }),
        comment: (input) =>
          Effect.sync(() => {
            writes.push(`comment ${input.scope} ${input.key}`);
          }),
        setState: (input) =>
          Effect.sync(() => {
            writes.push(`state ${input.scope} ${input.key}`);
          }),
      });
      const api: StandaloneIssueTrackerApi = {
        ...base,
        kind: JIRA,
        standalone: { ...base.standalone, tracker: JIRA, host: null },
      };
      const service = yield* makeService({
        projects: [project({ id: "web" })],
        trackers: [api],
        bindings: { web: { tracker: JIRA, scope: "ENG", host: "tenant.atlassian.net" } },
      });
      const ref = yield* service.resolveUrl(
        "https://tenant.atlassian.net/browse/ENG-123?focusedCommentId=1",
      );
      expect(ref).toEqual({
        projectId: "web",
        tracker: JIRA,
        host: "tenant.atlassian.net",
        scope: "ENG",
        key: "ENG-123",
        writable: true,
      });
      expect(reads).toBe(0);
      yield* service.detail(ref);
      yield* service.comment({ ...ref, body: "Hello" });
      yield* service.setState({ ...ref, state: "closed" });
      expect(writes).toEqual(["comment ENG ENG-123", "state ENG ENG-123"]);
      const foreign = yield* service.resolveUrl("https://tenant.atlassian.net/browse/OPS-1");
      expect(foreign).toEqual({
        projectId: "web",
        tracker: JIRA,
        host: "tenant.atlassian.net",
        scope: "OPS",
        key: "OPS-1",
        writable: false,
      });
      expect(reads).toBe(1);
      expect(yield* service.detail(foreign)).toMatchObject({ writable: false });
      for (const operation of [
        service.comment({ ...foreign, body: "Hello" }),
        service.setState({ ...foreign, state: "closed" }),
      ]) {
        expect(yield* Effect.flip(operation)).toMatchObject({
          _tag: "IssueOperationError",
          reason: "read-only",
        });
      }
      for (const url of [
        "https://other.atlassian.net/browse/ENG-123",
        "https://other.atlassian.net/browse/OPS-1",
      ]) {
        expect(yield* Effect.flip(service.resolveUrl(url))).toMatchObject({
          _tag: "IssueUnavailableError",
        });
      }
      expect(reads).toBe(2);
      expect(writes).toEqual(["comment ENG ENG-123", "state ENG ENG-123"]);
      const unbound = yield* makeService({ projects: [project({ id: "web" })], trackers: [api] });
      expect(
        yield* Effect.flip(unbound.resolveUrl("https://tenant.atlassian.net/browse/OPS-1")),
      ).toMatchObject({ _tag: "IssueUnavailableError" });
    }),
);

it.effect("does not lend a standalone project's credentials to an unbound team", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [project({ id: "web" })],
      trackers: [
        fakeStandaloneTracker({ getIssue: () => Effect.die("Unbound team must not read") }),
      ],
      bindings: { web: { tracker: LINEAR, scope: "ENG" } },
    });
    expect(
      yield* Effect.flip(service.resolveUrl("https://linear.app/acme/issue/QA-123/title")),
    ).toMatchObject({ _tag: "IssueUnavailableError" });
  }),
);

it.effect(
  "recognizes a configured GitHub Enterprise hostname and keeps foreign repositories read-only",
  () =>
    Effect.gen(function* () {
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web", host: "git.acme.test" })],
        trackers: [
          fakeTracker({ listIssues: () => Effect.die("URL resolution must not list issues") }),
        ],
      });
      expect(yield* service.resolveUrl("https://git.acme.test/acme/web/issues/7")).toEqual({
        projectId: "web",
        tracker: GITHUB,
        host: "git.acme.test",
        scope: "acme/web",
        key: "7",
        writable: true,
      });
      expect(yield* service.resolveUrl("https://git.acme.test/acme/other/issues/7")).toMatchObject({
        scope: "acme/other",
        writable: false,
      });
      expect(
        yield* Effect.flip(service.resolveUrl("https://other.acme.test/acme/web/issues/7")),
      ).toMatchObject({ _tag: "IssueOperationError", reason: "not-found" });
    }),
);

it.effect("keeps a GitLab HTTP remote's port when its canonical repository key omits it", () =>
  Effect.gen(function* () {
    const gitlab = IssueTrackerKind.make("gitlab");
    const shell = project({
      id: "web",
      repository: "acme/web",
      host: "gitlab.company.test",
      provider: "gitlab",
    });
    const repositoryIdentity = shell.repositoryIdentity!;
    const configured = {
      ...shell,
      repositoryIdentity: {
        ...repositoryIdentity,
        locator: {
          ...repositoryIdentity.locator,
          remoteUrl: "https://gitlab.company.test:8443/acme/web.git",
        },
      },
    };
    const listed: string[] = [];
    const service = yield* makeService({
      projects: [configured],
      trackers: [
        fakeTracker({
          kind: gitlab,
          listIssues: (input) =>
            Effect.sync(() => {
              listed.push(input.host);
              return { items: [], nextCursor: null };
            }),
          getIssue: () => Effect.die("URL resolution must not read issues"),
        }),
      ],
    });
    expect(yield* service.list({ state: "open", projectId: shell.id })).toMatchObject({
      sources: [{ projectId: "web", host: "gitlab.company.test:8443", scope: "acme/web" }],
    });
    expect(listed).toEqual(["gitlab.company.test:8443"]);
    expect(
      yield* service.resolveUrl("https://gitlab.company.test:8443/acme/web/-/issues/7"),
    ).toMatchObject({
      projectId: "web",
      host: "gitlab.company.test:8443",
      scope: "acme/web",
      writable: true,
    });
    expect(
      yield* service.resolveUrl("https://gitlab.company.test:8443/acme/other/-/issues/7"),
    ).toMatchObject({
      projectId: "web",
      host: "gitlab.company.test:8443",
      scope: "acme/other",
      writable: false,
    });
    for (const host of ["gitlab.company.test", "gitlab.company.test:9443"]) {
      expect(
        yield* Effect.flip(service.resolveUrl(`https://${host}/acme/web/-/issues/7`)),
      ).toMatchObject({ _tag: "IssueUnavailableError" });
    }
    expect(configured.repositoryIdentity.canonicalKey).toBe("gitlab.company.test/acme/web");
  }),
);

it.effect.each([
  { tracker: "github", path: "/issues/7" },
  { tracker: "gitlab", path: "/-/issues/7" },
  { tracker: "forgejo", path: "/issues/7" },
])(
  "resolves custom ports for $tracker without lending another install's source",
  ({ tracker, path }) =>
    Effect.gen(function* () {
      const kind = IssueTrackerKind.make(tracker);
      const service = yield* makeService({
        projects: [
          project({
            id: "web",
            repository: "acme/web",
            host: "git.acme.test:3000",
            provider: tracker,
          }),
          project({
            id: "other",
            repository: "acme/web",
            host: "git.acme.test:4000",
            provider: tracker,
          }),
        ],
        trackers: [
          fakeTracker({
            kind,
            getIssue: () => Effect.die("URL resolution must not read issues"),
            listIssues: () => Effect.die("URL resolution must not list issues"),
          }),
        ],
      });
      for (const [port, projectId] of [
        ["3000", "web"],
        ["4000", "other"],
      ] as const) {
        expect(
          yield* service.resolveUrl(
            `https://git.acme.test:${port}/acme/web${path}`,
            ProjectId.make("other"),
          ),
        ).toEqual({
          projectId,
          tracker: kind,
          host: `git.acme.test:${port}`,
          scope: "acme/web",
          key: "7",
          writable: true,
        });
        expect(
          yield* service.resolveUrl(`https://git.acme.test:${port}/acme/foreign${path}`),
        ).toMatchObject({
          projectId,
          host: `git.acme.test:${port}`,
          scope: "acme/foreign",
          writable: false,
        });
      }
      expect(
        yield* Effect.flip(service.resolveUrl(`https://git.acme.test:5000/acme/web${path}`)),
      ).toMatchObject({
        _tag: tracker === "gitlab" ? "IssueUnavailableError" : "IssueOperationError",
      });
    }),
);

it.effect("matches a Git host's normalized default HTTPS port", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({
          id: "web",
          repository: "acme/web",
          host: "git.acme.test:443",
          provider: "forgejo",
        }),
      ],
      trackers: [
        fakeTracker({
          kind: IssueTrackerKind.make("forgejo"),
          getIssue: () => Effect.die("URL resolution must not read issues"),
        }),
      ],
    });
    expect(yield* service.resolveUrl("https://git.acme.test:443/acme/web/issues/7")).toMatchObject({
      projectId: "web",
      host: "git.acme.test",
      writable: true,
    });
  }),
);

it.effect("resolves a configured Forgejo source before a GitHub-looking hostname", () =>
  Effect.gen(function* () {
    const forgejo = IssueTrackerKind.make("forgejo");
    const service = yield* makeService({
      projects: [
        project({
          id: "web",
          repository: "acme/web",
          host: "github.company.net",
          provider: "forgejo",
        }),
      ],
      trackers: [
        fakeTracker({
          kind: forgejo,
          listIssues: () => Effect.die("URL resolution must not list issues"),
        }),
      ],
    });
    expect(yield* service.resolveUrl("https://github.company.net/acme/web/issues/7")).toEqual({
      projectId: "web",
      tracker: forgejo,
      host: "github.company.net",
      scope: "acme/web",
      key: "7",
      writable: true,
    });
  }),
);

it.effect.each([
  {
    host: "dev.azure.com",
    repository: "acme/My%20Project/_git/repo",
    url: "https://dev.azure.com/acme/My%20Project/_workitems/edit/7",
  },
  {
    host: "acme.visualstudio.com",
    repository: "My%20Project/_git/repo",
    url: "https://acme.visualstudio.com/My%20Project/_workitems/edit/7",
  },
  {
    host: "acme.visualstudio.com",
    repository: "DefaultCollection/My%20Project/_git/repo",
    url: "https://acme.visualstudio.com/DefaultCollection/My%20Project/_workitems/edit/7",
  },
])(
  "uses the decoded Azure project for list, detail, writes and URL refs from $host/$repository",
  ({ host, repository, url }) =>
    Effect.gen(function* () {
      const azure = IssueTrackerKind.make("azure-devops");
      const scopes: string[] = [];
      const service = yield* makeService({
        projects: [project({ id: "web", provider: "azure-devops", host, repository })],
        trackers: [
          fakeTracker({
            kind: azure,
            listIssues: (input) =>
              Effect.sync(() => {
                scopes.push(input.scope);
                return { items: [{ ...issue("7"), url }], nextCursor: null };
              }),
            getIssue: (input) =>
              Effect.sync(() => {
                scopes.push(input.scope);
                return { ...issue(input.key), url };
              }),
            update: (input) =>
              Effect.sync(() => {
                scopes.push(input.scope);
              }),
          }),
        ],
      });
      const listed = yield* service.list({ state: "open" });
      expect(listed.entries[0]).toMatchObject({ tracker: azure, host, scope: "acme/My Project" });
      const ref = yield* service.resolveUrl(url);
      expect(ref).toMatchObject({
        tracker: azure,
        host,
        scope: "acme/My Project",
        key: "7",
        writable: true,
      });
      expect(yield* service.detail(ref)).toMatchObject({
        writable: true,
        scope: "acme/My Project",
      });
      yield* service.update({ ...ref, title: "Changed" });
      expect(scopes).toEqual(["acme/My Project", "acme/My Project", "acme/My Project"]);
    }),
);

it.effect("reuses known Linear comment viewers through the real service and driver", () =>
  Effect.gen(function* () {
    const operations: string[] = [];
    const user = {
      id: "native-viewer",
      name: "Viewer",
      displayName: "Viewer",
      email: "fake@example.test",
      avatarUrl: null,
    };
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const body = request.body;
          const payload = JSON.parse(
            body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "{}",
          ) as { query: string };
          operations.push(/^(?:query|mutation) (\w+)/.exec(payload.query)?.[1] ?? "unknown");
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                data: {
                  issue: {
                    id: "issue-id",
                    identifier: "ENG-7",
                    url: "https://linear.app/acme/issue/ENG-7",
                    team: { key: "ENG" },
                    comments: {
                      nodes: [
                        {
                          id: "comment-id",
                          body: "Owned",
                          createdAt: "2026-10-01T00:00:00.000Z",
                          url: null,
                          user,
                          reactions: [{ id: "reaction-id", emoji: "👍", user }],
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              }),
              { headers: { "content-type": "application/json" } },
            ),
          );
        }),
      ),
    );
    const driver = yield* LinearIssueTracker.make.pipe(
      Effect.provide(
        LinearApi.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              http,
              RateLimit.layer,
              Layer.succeed(
                IssueTrackerHost.IssueTrackerHost,
                IssueTrackerHost.IssueTrackerHost.of({
                  credentials: { get: () => Effect.succeedSome("fake-token") },
                }),
              ),
              Layer.succeed(
                Crypto.Crypto,
                Crypto.make({
                  randomBytes: (size) => new Uint8Array(size).fill(1),
                  digest: (_algorithm, data) => Effect.succeed(data),
                }),
              ),
            ),
          ),
        ),
      ),
    );
    const service = yield* makeService({
      projects: [project({ id: "web" })],
      trackers: [driver],
      bindings: { web: { tracker: LINEAR, scope: "acme/ENG" } },
    });
    for (const viewer of [user.id, "another-viewer"]) {
      const result = yield* service.comments({
        projectId: ProjectId.make("web"),
        tracker: LINEAR,
        host: "linear.app",
        scope: "acme/ENG",
        key: "ENG-7",
        cursor: "older",
        viewer,
      });
      expect(result.comments[0]?.reactions?.[0]?.viewerHasReacted).toBe(viewer === user.id);
    }
    expect(operations).toEqual(["T3Comments", "T3Comments"]);
  }),
);

it.effect("keeps native Forgejo involvement viewers separate across case-distinct mounts", () => {
  const host = "forgejo.test";
  const installs = [
    { id: "upper", mount: "Mount", account: "alice" },
    { id: "lower", mount: "mount", account: "bob" },
  ];
  const native: { phase: string; path: string }[] = [];
  let phase = "resolve";
  const remoteFor = (cwd: string) => {
    const install = installs.find((item) => cwd === `/w/${item.id}`)!;
    return `https://${host}/${install.mount}/Acme/Web.git`;
  };
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const tracker = yield* ForgejoIssueTracker.make.pipe(
      Effect.provideService(ForgejoCli.ForgejoCli, cli),
    );
    const provider = yield* ForgejoSourceControlProvider.make.pipe(
      Effect.provideService(ForgejoCli.ForgejoCli, cli),
    );
    const discovery = yield* ForgejoSourceControlProvider.makeDiscovery.pipe(
      Effect.provideService(ForgejoCli.ForgejoCli, cli),
    );
    const { process } = yield* SourceControlHost.SourceControlHost;
    const identities = yield* RepositoryIdentityResolver.make({
      refine: (identity) =>
        provider.refineRepositoryIdentity!({
          identity,
          resolveContext: (input) =>
            refineUnknownRemoteProvider({
              specs: [discovery],
              process,
              cwd: input.cwd,
              context: input.context,
            }),
        }),
    }).pipe(
      Effect.provide(
        Layer.mock(ProcessRunner.ProcessRunner)({
          run: (input) => {
            const cwd = input.args[input.args.indexOf("-C") + 1]!;
            return Effect.succeed({
              stdout: input.args.includes("--show-toplevel")
                ? cwd
                : `origin\t${remoteFor(cwd)} (fetch)\n`,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
          },
        }),
      ),
    );
    const projects = yield* Effect.forEach(installs, (install) =>
      Effect.gen(function* () {
        const identity = yield* identities.resolve(`/w/${install.id}`);
        expect(identity?.webUrl).toBe(`https://${host}/${install.mount}/Acme/Web`);
        return { ...project({ id: install.id }), repositoryIdentity: identity };
      }),
    );
    const service = yield* makeService({
      projects,
      trackers: [tracker],
      resolveRepository: identities.resolve,
    });
    for (const install of installs) {
      phase = `direct-viewer-${install.id}`;
      expect(yield* tracker.getViewer({ cwd: `/w/${install.id}`, host })).toBe(install.account);
      expect(yield* service.sources(ProjectId.make(install.id))).toEqual([
        { tracker: "forgejo", host, scope: `${install.mount}/acme/web` },
      ]);
    }
    const outcomes: {
      involvement: string;
      actualScopes: string[];
      expectedScopes: string[];
      viewers: unknown;
    }[] = [];
    for (const involvement of ["assigned", "authored", "mentioned"] as const) {
      for (const install of installs) {
        phase = `single-${involvement}-${install.id}`;
        const answer = yield* service.list({
          projectId: ProjectId.make(install.id),
          state: "open",
          involvement,
        });
        expect(answer.errors).toEqual([]);
        expect(answer.entries.map((entry) => entry.scope)).toEqual([`${install.mount}/acme/web`]);
        expect(answer.viewers).toMatchObject({ [`forgejo ${host}`]: install.account });
      }
      phase = `combined-${involvement}`;
      const answer = yield* service.list({ state: "open", involvement });
      expect(answer.errors).toEqual([]);
      outcomes.push({
        involvement,
        actualScopes: answer.entries.map((entry) => entry.scope).sort(),
        expectedScopes: ["Mount/acme/web", "mount/acme/web"],
        viewers: answer.viewers,
      });
    }
    const counts = [...new Set(native.map((call) => call.phase))].map((name) => ({
      phase: name,
      native: native.filter((call) => call.phase === name).length,
      user: native.filter((call) => call.phase === name && call.path.endsWith("/user")).length,
      issueList: native.filter((call) => call.phase === name && call.path.endsWith("/issues"))
        .length,
    }));
    for (const outcome of outcomes) {
      expect(outcome.actualScopes).toEqual(outcome.expectedScopes);
      expect(outcome.viewers).toEqual({
        [`forgejo ${host} Mount/acme/web`]: "alice",
        [`forgejo ${host} mount/acme/web`]: "bob",
      });
      const phaseCounts = counts.find(
        (count) => count.phase === `combined-${outcome.involvement}`,
      )!;
      expect({
        native: phaseCounts.native,
        user: phaseCounts.user,
        issueList: phaseCounts.issueList,
      }).toEqual({ native: 4, user: 2, issueList: 2 });
    }
    for (const count of counts.filter((item) => item.phase.startsWith("single-"))) {
      expect({ native: count.native, user: count.user, issueList: count.issueList }).toEqual({
        native: 2,
        user: 1,
        issueList: 1,
      });
    }
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.HomeDirectory, "/fake-home"),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected HTTP")),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            if (input.command === "git")
              return Effect.succeed(
                TestSourceControlHost.processOutput(`origin\t${remoteFor(input.cwd)} (fetch)\n`),
              );
            if (input.command !== "tea")
              return Effect.die(`Unexpected native process ${input.command}`);
            if (input.args[0] === "login")
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  JSON.stringify(
                    installs.map((item) => ({
                      name: item.id,
                      url: `https://${host}/${item.mount}`,
                      ssh_host: host,
                      user: item.account,
                      default: "false",
                    })),
                  ),
                ),
              );
            if (input.args[0] !== "api") return Effect.die("Unexpected tea command");
            const endpoint = new URL(input.args.at(-1)!);
            const install = installs.find((item) =>
              endpoint.pathname.startsWith(`/${item.mount}/api/v1/`),
            );
            if (!install) return Effect.die(`Unexpected native path ${endpoint.pathname}`);
            const login = input.args[input.args.indexOf("--login") + 1]!;
            expect(login).toBe(install.id);
            const method = input.args[input.args.indexOf("--method") + 1]!;
            expect(method).toBe("GET");
            let value: unknown;
            if (endpoint.pathname.endsWith("/user")) value = { login: install.account };
            else if (endpoint.pathname.toLowerCase().endsWith("/repos/acme/web/issues")) {
              const filter =
                endpoint.searchParams.get("assigned_by") ??
                endpoint.searchParams.get("created_by") ??
                endpoint.searchParams.get("mentioned_by");
              value =
                filter !== null && filter !== install.account
                  ? []
                  : [
                      {
                        number: 42,
                        title: `${install.account} issue`,
                        html_url: `https://${host}/${install.mount}/Acme/Web/issues/42`,
                        user: { login: install.account },
                        state: "open",
                        body: "",
                        created_at: "2026-10-01T00:00:00Z",
                        updated_at: "2026-10-01T00:00:00Z",
                        assignees: [{ login: install.account }],
                        comments: 0,
                      },
                    ];
            } else return Effect.die(`Unexpected native API ${endpoint.pathname}`);
            native.push({ phase, path: endpoint.pathname });
            return Effect.succeed(
              TestSourceControlHost.processOutput(JSON.stringify(value), {
                stderr: 'HTTP/1.1 200\nLink: <https://fixture.invalid>; rel="last"\n',
              }),
            );
          },
        },
      }),
    ),
  );
});
