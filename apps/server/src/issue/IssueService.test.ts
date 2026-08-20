import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  issueProjectSourceKey,
  issueSourceKey,
  type IssueCapabilities,
  type IssueTemplateList,
  type IssueProviderKind,
  type IssueViewerPermissions,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  IssueProviderError,
  type ProviderBatchedIssue,
  type ProviderIssue,
  type ProviderIssueDetail,
  type IssueAdapter,
} from "./IssueProvider.ts";
import { IssueProviderRegistry, fromProviders } from "./IssueProviderRegistry.ts";
import * as IssueService from "./IssueService.ts";

function project(input: {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repository?: string;
  readonly provider?: string;
  readonly host?: string;
}): OrchestrationProjectShell {
  // The host defaults from the provider, so a fixture only names one when the point of the
  // test is two hosts of the same kind.
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

function issue(number: number, updatedAt: string): ProviderIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://host/issues/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    state: "open",
    stateReason: null,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    closedAt: null,
    assignees: [],
    labels: [],
    milestone: null,
    commentCount: 0,
  };
}

function issueDetail(
  number: number,
  overrides: Partial<ProviderIssueDetail> = {},
): ProviderIssueDetail {
  return {
    ...issue(number, "2026-07-02T00:00:00Z"),
    body: "What went wrong",
    linkedPullRequests: [],
    viewerPermissions: FULL_PERMISSIONS,
    ...overrides,
  };
}

function unusable(provider: IssueProviderKind, reason: "missing-tool" | "unauthenticated") {
  return new IssueProviderError({
    provider,
    operation: "getViewer",
    reason,
    detail: `${provider} is not usable.`,
  });
}

const trackerDisabled = new IssueProviderError({
  provider: "github",
  operation: "listIssues",
  reason: "tracker-disabled",
  detail: "Issues are disabled for this repository.",
});

/** Everything a host could offer, so a fixture only narrows what its own test is about. */
const FULL_CAPABILITIES: IssueCapabilities = {
  comment: true,
  actions: ["close", "reopen"],
  closeReasons: ["completed", "not-planned"],
  create: true,
  issueTemplates: true,
  edit: true,
  editComment: true,
  reactions: true,
  labels: true,
  assignees: true,
  listLabelCandidates: true,
  listAssigneeCandidates: true,
  search: true,
  linkedPullRequests: true,
  timelineEvents: true,
};

/** A viewer who may do everything the host can, so a test only narrows what it is about. */
const FULL_PERMISSIONS: IssueViewerPermissions = {
  actions: ["close", "reopen"],
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
  create: true,
};

/** A provider whose every call is supplied by the test; anything unset succeeds emptily. */
function fakeProvider(
  kind: IssueProviderKind,
  overrides: Partial<IssueAdapter> = {},
): IssueAdapter {
  return {
    kind,
    capabilities: FULL_CAPABILITIES,
    getViewer: () => Effect.succeed("bilal"),
    getViewerPermissions: () => Effect.succeed(FULL_PERMISSIONS),
    listIssues: () => Effect.succeed({ items: [], truncated: false, continues: true }),
    getIssue: () => Effect.die("unused"),
    getIssueActivity: () => Effect.die("unused"),
    runAction: () => Effect.void,
    comment: () => Effect.void,
    create: () => Effect.succeed({ number: 1, url: "https://host/issues/1" }),
    update: () => Effect.void,
    setLabels: () => Effect.void,
    setAssignees: () => Effect.void,
    listLabelCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
    listAssigneeCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
    ...overrides,
  };
}

function makeService(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly providers: ReadonlyArray<IssueAdapter>;
}) {
  return IssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(IssueProviderRegistry, fromProviders(input.providers)),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: input.projects,
              threads: [],
              updatedAt: "2026-07-01T00:00:00Z",
            }),
        }),
      ),
    ),
  );
}

function cursorKey(repository: string): string {
  return `github.com ${repository}`;
}

/** The reference every write test aims at, so a test body only says what it is about. */
const REFERENCE = { projectId: "p1" as ProjectId, repository: "acme/web", number: 7 };

const ONE_PROJECT = [
  project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
];

/** The two writes whose capability and permission refusals are checked as a pair. */
const labelling = (service: IssueService.IssueService["Service"]) =>
  service.setLabels({ ...REFERENCE, labels: ["bug"] });

const assigning = (service: IssueService.IssueService["Service"]) =>
  service.setAssignees({ ...REFERENCE, assignees: ["bilal"] });

it.effect("puts every host's issues on one page, newest update first", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({ id: "p2", title: "api", workspaceRoot: "/b", repository: "acme/api" }),
        project({
          id: "p3",
          title: "on gitlab",
          workspaceRoot: "/c",
          repository: "group/sub/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listIssues: ({ repository }) =>
            Effect.succeed({
              items:
                repository === "acme/web"
                  ? [issue(1, "2026-07-02T00:00:00Z")]
                  : [issue(2, "2026-07-05T00:00:00Z")],
              truncated: false,
              continues: true,
            }),
        }),
        fakeProvider("gitlab", {
          listIssues: ({ repository }) =>
            // Nested groups need the full path, not the last two segments.
            repository === "group/sub/project"
              ? Effect.succeed({
                  items: [issue(3, "2026-07-04T00:00:00Z")],
                  truncated: false,
                  continues: true,
                })
              : Effect.die("wrong repository identity"),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(
      result.entries.map((entry) => [entry.projectId, entry.number]),
      [
        ["p2", 2],
        ["p3", 3],
        ["p1", 1],
      ],
    );
  }),
);

it.effect("keeps a row already sent at the boundary instant from arriving twice", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          // The boundary instant is asked for inclusively, so the host hands back the rows
          // already sent at it alongside the ones beside them — which a strictly-older read
          // would have lost instead.
          listIssues: () =>
            Effect.succeed({
              items: [
                issue(7, "2026-07-02T00:00:00Z"),
                issue(8, "2026-07-02T00:00:00Z"),
                issue(9, "2026-07-01T00:00:00Z"),
              ],
              truncated: true,
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      cursors: { [cursorKey("acme/web")]: "2026-07-02T00:00:00Z|1|7" },
    });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [8, 9],
    );
    // The cursor sent in still carries the row count no host pages by any more, and is taken as it
    // stands; the one handed back writes that field out as zero.
    assert.deepStrictEqual(result.nextCursors, {
      [cursorKey("acme/web")]: "2026-07-01T00:00:00Z|0|9",
    });
  }),
);

it.effect("keeps the earlier exclusions when a slice ends on the instant it began on", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: () =>
            Effect.succeed({
              items: [issue(7, "2026-07-02T00:00:00Z"), issue(8, "2026-07-02T00:00:00Z")],
              truncated: true,
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      cursors: { [cursorKey("acme/web")]: "2026-07-02T00:00:00Z|1|6" },
    });

    // A triage afternoon puts a whole slice inside one second. The next read has to keep
    // excluding 6 as well as the two just sent, or it hands 6 over again.
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [7, 8],
    );
    assert.deepStrictEqual(result.nextCursors, {
      [cursorKey("acme/web")]: "2026-07-02T00:00:00Z|0|6,7,8",
    });
  }),
);

it.effect("carries on from a slice that was nothing but rows it had already sent", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: () =>
            Effect.succeed({
              items: [issue(7, "2026-07-02T00:00:00Z")],
              truncated: true,
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      cursors: { [cursorKey("acme/web")]: "2026-07-02T00:00:00Z|1|7" },
    });

    // Nothing survived de-duplication, and reading that as "nothing left" would strand every
    // older row for good.
    assert.deepStrictEqual(result.entries, []);
    assert.deepStrictEqual(result.nextCursors, {
      [cursorKey("acme/web")]: "2026-07-02T00:00:00Z|0|7",
    });
  }),
);

it.effect("refuses a continuation it did not issue, before asking any host anything", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [fakeProvider("github", { listIssues: () => Effect.die("should not be read") })],
    });

    const error = yield* Effect.flip(
      service.list({ state: "open", cursors: { [cursorKey("acme/web")]: "yesterday" } }),
    );

    assert.strictEqual(error._tag, "IssueOperationError");
  }),
);

it.effect("keeps a host listing when one of its repositories has the tracker switched off", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({ id: "p2", title: "api", workspaceRoot: "/b", repository: "acme/api" }),
      ],
      providers: [
        fakeProvider("github", {
          listIssues: ({ repository }) =>
            repository === "acme/web"
              ? Effect.fail(trackerDisabled)
              : Effect.succeed({
                  items: [issue(2, "2026-07-05T00:00:00Z")],
                  truncated: false,
                  continues: true,
                }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    // One repository's setting is not a dead host: saying so would hide every other repository
    // on the account.
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [2],
    );
    assert.deepStrictEqual(result.errors, [
      {
        projectId: "p1" as ProjectId,
        projectTitle: "web",
        message: "Issue tracker is switched off for acme/web.",
      },
    ]);
    assert.deepStrictEqual(
      result.providers.map((summary) => [summary.host, summary.configured]),
      [["github.com", true]],
    );
  }),
);

it.effect("says what a host whose tool is missing needs before it can be read", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({
          id: "p2",
          title: "on gitlab",
          workspaceRoot: "/b",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listIssues: () =>
            Effect.succeed({
              items: [issue(1, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            }),
        }),
        fakeProvider("gitlab", {
          getViewer: () => Effect.fail(unusable("gitlab", "missing-tool")),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.provider),
      ["github"],
    );
    const gitlab = result.providers.find((summary) => summary.kind === "gitlab");
    assert.strictEqual(gitlab?.configured, false);
    // The fix rather than whatever the tool printed: "gitlab is not usable" names no next step.
    assert.strictEqual(
      gitlab?.detail,
      "GitLab CLI (`glab`) is required to browse issues on this host. Install it from https://gitlab.com/gitlab-org/cli and reload.",
    );
  }),
);

it.effect("says what a host with an unauthenticated tool needs before it can be read", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({
          id: "p2",
          title: "enterprise",
          workspaceRoot: "/b",
          repository: "acme/api",
          host: "github.acme.dev",
        }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: ({ cwd }) =>
            cwd === "/a"
              ? Effect.succeed("bilal")
              : Effect.fail(unusable("github", "unauthenticated")),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    const enterprise = result.providers.find((summary) => summary.host === "github.acme.dev");
    assert.strictEqual(enterprise?.configured, false);
    assert.strictEqual(
      enterprise?.detail,
      "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
    );
    // Its repositories are named rather than dropped, so "N unavailable" stays honest.
    assert.deepStrictEqual(
      result.errors.map((error) => error.projectId),
      ["p2"],
    );
  }),
);

it.effect("reports a host with no implementation rather than dropping its projects", () =>
  Effect.gen(function* () {
    const listed: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({ id: "p2", title: "notes", workspaceRoot: "/b" }),
        project({
          id: "p3",
          title: "on gitlab",
          workspaceRoot: "/c",
          repository: "group/project",
          provider: "gitlab",
        }),
        project({
          id: "p4",
          title: "also on gitlab",
          workspaceRoot: "/d",
          repository: "group/other",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listIssues: ({ repository }) => {
            listed.push(repository);
            return Effect.succeed({
              items: [issue(1, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(listed, ["acme/web"]);
    assert.deepStrictEqual(
      result.providers.map((summary) => [
        summary.host,
        summary.kind,
        summary.configured,
        summary.projectCount,
        summary.detail,
      ]),
      [
        ["github.com", "github", true, 1, null],
        ["gitlab.com", "gitlab", false, 2, "This host cannot be browsed here yet."],
      ],
    );
  }),
);

it.effect("fails as unavailable only when no host this request covers can be read", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewer: () => Effect.fail(unusable("github", "missing-tool")),
        }),
      ],
    });

    const error = yield* Effect.flip(service.list({ state: "open" }));

    assert.strictEqual(error._tag, "IssueUnavailableError");
    assert.strictEqual(error._tag === "IssueUnavailableError" ? error.reason : null, "cli-missing");
  }),
);

it.effect("asks each host for the account signed in on that host, not on another", () =>
  Effect.gen(function* () {
    const asked: Array<[string, string, string]> = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "cloud", workspaceRoot: "/cloud", repository: "acme/web" }),
        project({
          id: "p2",
          title: "enterprise",
          workspaceRoot: "/enterprise",
          // The same path on a different host: neither the account nor the row may be shared.
          repository: "acme/web",
          host: "github.acme.dev",
        }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: ({ cwd }) => Effect.succeed(cwd === "/cloud" ? "bilal" : "b.hassan"),
          listIssues: ({ host, viewer, involvement }) => {
            asked.push([host, viewer, involvement]);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open", involvement: "assigned" });

    assert.deepStrictEqual(asked.toSorted(), [
      ["github.acme.dev", "b.hassan", "assigned"],
      ["github.com", "bilal", "assigned"],
    ]);
    assert.deepStrictEqual(result.viewers, {
      "github.com": "bilal",
      "github.acme.dev": "b.hassan",
      [issueSourceKey("github", "github.com")]: "bilal",
      [issueSourceKey("github", "github.acme.dev")]: "b.hassan",
      [issueProjectSourceKey("github", "github.com", "p1" as ProjectId)]: "bilal",
      [issueProjectSourceKey("github", "github.acme.dev", "p2" as ProjectId)]: "b.hassan",
    });
  }),
);

it.effect("keeps adapters separate when they share a host and repository name", () =>
  Effect.gen(function* () {
    const asked: string[] = [];
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "source",
          workspaceRoot: "/source",
          repository: "acme/web",
          host: "tracker.example.test",
        }),
        project({ id: "p2", title: "planning", workspaceRoot: "/planning" }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: () => Effect.succeed("octocat"),
          listIssues: ({ viewer }) => {
            asked.push(`github:${viewer}`);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
        }),
        fakeProvider("jira", {
          resolveSource: (candidate) =>
            Effect.succeed(
              candidate.id === "p2"
                ? { host: "tracker.example.test", repository: "acme/web" }
                : null,
            ),
          getViewer: () => Effect.succeed("jira-user"),
          listIssues: ({ viewer }) => {
            asked.push(`jira:${viewer}`);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(result.providers.map(({ kind }) => kind).toSorted(), ["github", "jira"]);
    assert.deepStrictEqual(asked.toSorted(), ["github:octocat", "jira:jira-user"]);
  }),
);

it.effect("routes each repository on one project through its matching adapter", () =>
  Effect.gen(function* () {
    const asked: string[] = [];
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("linear", {
          resolveSource: () =>
            Effect.succeed({
              host: "linear.app",
              repository: REFERENCE.repository,
              credentialId: "user-1",
            }),
          getIssue: ({ repository }) => {
            asked.push(`linear:${repository}`);
            return Effect.succeed(issueDetail(7, { title: "Linear issue" }));
          },
        }),
        fakeProvider("github", {
          getIssue: ({ repository }) => {
            asked.push(`github:${repository}`);
            return Effect.succeed(issueDetail(7, { title: "GitHub issue" }));
          },
        }),
      ],
    });

    const linear = yield* service.detail({ ...REFERENCE, provider: "linear" });
    const github = yield* service.detail({ ...REFERENCE, provider: "github" });

    assert.strictEqual(linear.title, "Linear issue");
    assert.strictEqual(github.title, "GitHub issue");
    assert.deepStrictEqual(asked, ["linear:acme/web", "github:acme/web"]);
  }),
);

it.effect("keeps a project available when one of its issue sources is unreadable", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("linear", {
          resolveSource: () =>
            Effect.succeed({ host: "linear.app", repository: "ENG", credentialId: "user-1" }),
          getViewer: () => Effect.fail(unusable("linear", "unauthenticated")),
        }),
        fakeProvider("github", {
          listIssues: () =>
            Effect.succeed({
              items: [issue(7, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            }),
        }),
      ],
    });

    const listed = yield* service.list({ state: "open" });

    assert.deepStrictEqual(
      listed.entries.map(({ provider }) => provider),
      ["github"],
    );
    assert.deepStrictEqual(listed.errors, []);
  }),
);

it.effect("routes projects on one host through distinct credential viewers", () =>
  Effect.gen(function* () {
    const viewers: Array<string | undefined> = [];
    const listings: Array<[string | undefined, string]> = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/web" }),
        project({ id: "p2", title: "api", workspaceRoot: "/api" }),
      ],
      providers: [
        fakeProvider("linear", {
          resolveSource: (candidate) =>
            Effect.succeed({
              host: "linear.app",
              repository: candidate.id === "p1" ? "ENG" : "OPS",
              credentialId: candidate.id === "p1" ? "user-1" : "user-2",
            }),
          getViewer: (input: { readonly credentialId?: string }) => {
            viewers.push(input.credentialId);
            return Effect.succeed(input.credentialId ?? "missing");
          },
          listIssues: (input: { readonly credentialId?: string; readonly repository: string }) => {
            listings.push([input.credentialId, input.repository]);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(viewers.toSorted(), ["user-1", "user-2"]);
    assert.deepStrictEqual(listings.toSorted(), [
      ["user-1", "ENG"],
      ["user-2", "OPS"],
    ]);
    assert.strictEqual(
      result.viewers[issueProjectSourceKey("linear", "linear.app", "p1" as ProjectId)],
      "user-1",
    );
    assert.strictEqual(
      result.viewers[issueProjectSourceKey("linear", "linear.app", "p2" as ProjectId)],
      "user-2",
    );
    assert.strictEqual(result.providers.length, 1);
    assert.strictEqual(result.providers[0]?.projectCount, 2);
  }),
);

it.effect("keeps separate cursors for accounts that use the same Linear team", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/web" }),
        project({ id: "p2", title: "api", workspaceRoot: "/api" }),
      ],
      providers: [
        fakeProvider("linear", {
          resolveSource: (candidate) =>
            Effect.succeed({
              host: "linear.app",
              repository: "ENG",
              credentialId: candidate.id === "p1" ? "user-1" : "user-2",
            }),
          getViewer: ({ credentialId }: { readonly credentialId?: string }) =>
            Effect.succeed(credentialId ?? "missing"),
          listIssues: ({ credentialId }: { readonly credentialId?: string }) =>
            Effect.succeed({
              items: [issue(credentialId === "user-1" ? 1 : 2, "2026-07-02T00:00:00Z")],
              truncated: true,
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(Object.keys(result.nextCursors).toSorted(), [
      '["linear","linear.app","eng","user-1"]',
      '["linear","linear.app","eng","user-2"]',
    ]);
  }),
);

it.effect("hands each involvement the reader picked straight to the host", () =>
  Effect.gen(function* () {
    const asked: string[] = [];
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: ({ involvement }) => {
            asked.push(involvement);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
        }),
      ],
    });

    yield* service.list({ state: "open" });
    yield* service.list({ state: "open", involvement: "assigned" });
    yield* service.list({ state: "open", involvement: "authored" });
    yield* service.list({ state: "open", involvement: "mentioned" });

    // Narrowing happens on the host, because a listing only ever holds a page per repository.
    assert.deepStrictEqual(asked, ["all", "assigned", "authored", "mentioned"]);
  }),
);

it.effect("refuses a repository that does not belong to the requested project", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [fakeProvider("github", { getIssue: () => Effect.die("must not be called") })],
    });

    const error = yield* Effect.flip(
      service.detail({ projectId: "p1" as ProjectId, repository: "attacker/repo", number: 7 }),
    );

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(error.message, "The issue does not belong to the selected project.");
  }),
);

it.effect("carries the change requests a host links to an issue through to the detail", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getIssue: () =>
            Effect.succeed(
              issueDetail(7, {
                linkedPullRequests: [
                  {
                    repository: "acme/web",
                    number: 42,
                    title: "Fix the thing",
                    url: "https://host/pull/42",
                    state: "open",
                    isDraft: false,
                    closesIssue: true,
                  },
                ],
              }),
            ),
        }),
      ],
    });

    const result = yield* service.detail(REFERENCE);

    assert.deepStrictEqual(
      result.linkedPullRequests.map((link) => [link.number, link.closesIssue]),
      [[42, true]],
    );
    assert.strictEqual(result.workspaceRoot, "/a");
  }),
);

it.effect("carries the signed-in account through to issue detail", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewer: () => Effect.succeed("bilal"),
          getIssue: () => Effect.succeed(issueDetail(7)),
        }),
      ],
    });

    const result = yield* service.detail(REFERENCE);

    assert.strictEqual(result.viewer, "bilal");
  }),
);

it.effect("refuses an action the host never claimed it could run", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          // A host that can close an issue but has no way to bring it back.
          capabilities: { ...FULL_CAPABILITIES, actions: ["close"] },
          getViewerPermissions: () => Effect.die("must not be asked"),
          runAction: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(service.runAction({ ...REFERENCE, action: "reopen" }));

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(error.message, "This host cannot reopen an issue.");
  }),
);

it.effect("refuses a close reason the host never said it records", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          // Everywhere but GitHub, a closed issue simply has no reason to report.
          capabilities: { ...FULL_CAPABILITIES, closeReasons: [] },
          runAction: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.runAction({ ...REFERENCE, action: "close", reason: "not-planned" }),
    );

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(error.message, "This host does not record why an issue was closed.");
  }),
);

it.effect("refuses an action this viewer may not take, and says what access it takes", () =>
  Effect.gen(function* () {
    let ran: string | null = null;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          // A reader who opened this issue: theirs to close, nobody else's to reopen.
          getViewerPermissions: () => Effect.succeed({ ...FULL_PERMISSIONS, actions: ["close"] }),
          runAction: ({ action }) => {
            ran = action;
            return Effect.void;
          },
        }),
      ],
    });

    const error = yield* Effect.flip(service.runAction({ ...REFERENCE, action: "reopen" }));
    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(
      error.message,
      "You need write access on this repository, or to have opened this issue, to reopen it.",
    );
    assert.strictEqual(ran, null);

    yield* service.runAction({ ...REFERENCE, action: "close" });
    assert.strictEqual(ran, "close");
  }),
);

it.effect("refuses a comment on a host that cannot post one, without asking anybody", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          capabilities: { ...FULL_CAPABILITIES, comment: false },
          getViewerPermissions: () => Effect.die("must not be asked"),
          comment: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(service.comment({ ...REFERENCE, body: "Thanks!" }));

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(error.message, "This host cannot post a comment on an issue.");
  }),
);

it.effect("refuses a comment this viewer may not post", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewerPermissions: () => Effect.succeed({ ...FULL_PERMISSIONS, comment: false }),
          comment: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(service.comment({ ...REFERENCE, body: "Thanks!" }));

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(
      error.message,
      "You need write access on this repository to comment on an issue.",
    );
  }),
);

it.effect("refuses a comment written out of spaces before it reaches the host", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [fakeProvider("github", { comment: () => Effect.die("must not be called") })],
    });

    const error = yield* Effect.flip(service.comment({ ...REFERENCE, body: "   \n  " }));

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(error.message, "A comment cannot be empty.");
  }),
);

it.effect("passes a rewritten issue comment through with its id and body", () =>
  Effect.gen(function* () {
    let received: { id: string; body: string } | null = null;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          updateComment: (input) => {
            received = { id: input.commentId, body: input.body };
            return Effect.void;
          },
        }),
      ],
    });

    yield* service.updateComment({ ...REFERENCE, commentId: "IC_1", body: "Second thoughts" });

    assert.deepStrictEqual(received, { id: "IC_1", body: "Second thoughts" });
  }),
);

it.effect("refuses to open an issue on a host that cannot file one", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          capabilities: { ...FULL_CAPABILITIES, create: false },
          create: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.create({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        title: "It broke",
        body: "",
        labels: [],
        assignees: [],
      }),
    );

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(error.message, "This host cannot open an issue.");
  }),
);

it.effect("refuses an edit on a host that cannot rewrite an issue", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          capabilities: { ...FULL_CAPABILITIES, edit: false },
          getViewerPermissions: () => Effect.die("must not be asked"),
          update: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(service.update({ ...REFERENCE, title: "A better title" }));

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(error.message, "This host cannot rewrite an issue.");
  }),
);

it.effect("refuses an edit that changes nothing, and one written out of spaces", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewerPermissions: () => Effect.die("must not be asked"),
          update: () => Effect.die("must not be called"),
        }),
      ],
    });

    const nothing = yield* Effect.flip(service.update(REFERENCE));
    assert.include(nothing.message, "An edit needs a new title or a new body.");

    const blankTitle = yield* Effect.flip(service.update({ ...REFERENCE, title: "   " }));
    assert.include(blankTitle.message, "A title cannot be empty.");

    // A body may legitimately be cleared, so only one written out of spaces is refused.
    const blankBody = yield* Effect.flip(service.update({ ...REFERENCE, body: "  \t " }));
    assert.include(blankBody.message, "A body cannot be only whitespace.");
  }),
);

it.effect("lets a cleared body through, which is a body somebody meant to empty", () =>
  Effect.gen(function* () {
    let written: string | undefined = "unset";
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          update: ({ body }) => {
            written = body;
            return Effect.void;
          },
        }),
      ],
    });

    yield* service.update({ ...REFERENCE, body: "" });

    assert.strictEqual(written, "");
  }),
);

it.effect("refuses an edit this viewer may not make", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewerPermissions: () => Effect.succeed({ ...FULL_PERMISSIONS, edit: false }),
          update: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(service.update({ ...REFERENCE, title: "A better title" }));

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(
      error.message,
      "You need write access on this repository, or to have opened this issue, to edit it.",
    );
  }),
);

it.effect("refuses labelling on a host that cannot label, and to a viewer who may not", () =>
  Effect.gen(function* () {
    const hostCannot = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          capabilities: { ...FULL_CAPABILITIES, labels: false },
          getViewerPermissions: () => Effect.die("must not be asked"),
          setLabels: () => Effect.die("must not be called"),
        }),
      ],
    });
    const refusedHost = yield* Effect.flip(labelling(hostCannot));
    assert.include(refusedHost.message, "This host cannot label an issue.");

    const viewerMayNot = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewerPermissions: () => Effect.succeed({ ...FULL_PERMISSIONS, labels: false }),
          setLabels: () => Effect.die("must not be called"),
        }),
      ],
    });
    const refusedViewer = yield* Effect.flip(labelling(viewerMayNot));
    assert.include(
      refusedViewer.message,
      "You need write access on this repository to change the labels on an issue.",
    );
  }),
);

it.effect("refuses assignment on a host that cannot assign, and to a viewer who may not", () =>
  Effect.gen(function* () {
    const hostCannot = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          capabilities: { ...FULL_CAPABILITIES, assignees: false },
          getViewerPermissions: () => Effect.die("must not be asked"),
          setAssignees: () => Effect.die("must not be called"),
        }),
      ],
    });
    const refusedHost = yield* Effect.flip(assigning(hostCannot));
    assert.include(refusedHost.message, "This host cannot assign an issue to somebody.");

    const viewerMayNot = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewerPermissions: () => Effect.succeed({ ...FULL_PERMISSIONS, assignees: false }),
          setAssignees: () => Effect.die("must not be called"),
        }),
      ],
    });
    const refusedViewer = yield* Effect.flip(assigning(viewerMayNot));
    assert.include(
      refusedViewer.message,
      "You need write access on this repository to change who an issue is assigned to.",
    );
  }),
);

it.effect(
  "keeps the label picker from a host without one, and from a viewer who may not label",
  () =>
    Effect.gen(function* () {
      const hostCannot = yield* makeService({
        projects: ONE_PROJECT,
        providers: [
          fakeProvider("github", {
            capabilities: { ...FULL_CAPABILITIES, listLabelCandidates: false },
            getViewerPermissions: () => Effect.die("must not be asked"),
            listLabelCandidates: () => Effect.die("must not be called"),
          }),
        ],
      });
      const refusedHost = yield* Effect.flip(hostCannot.labelCandidates(REFERENCE));
      assert.include(refusedHost.message, "This host cannot say which labels a repository has.");

      // The picker is the one the change is made from, so a viewer who may not apply a label is
      // offered no list whose every press was going to be turned down.
      const viewerMayNot = yield* makeService({
        projects: ONE_PROJECT,
        providers: [
          fakeProvider("github", {
            getViewerPermissions: () => Effect.succeed({ ...FULL_PERMISSIONS, labels: false }),
            listLabelCandidates: () => Effect.die("must not be called"),
          }),
        ],
      });
      const refusedViewer = yield* Effect.flip(viewerMayNot.labelCandidates(REFERENCE));
      assert.include(
        refusedViewer.message,
        "You need write access on this repository to change the labels on an issue.",
      );
    }),
);

it.effect(
  "keeps the assignee picker from a host without one, and from a viewer who may not assign",
  () =>
    Effect.gen(function* () {
      const hostCannot = yield* makeService({
        projects: ONE_PROJECT,
        providers: [
          fakeProvider("github", {
            capabilities: { ...FULL_CAPABILITIES, listAssigneeCandidates: false },
            getViewerPermissions: () => Effect.die("must not be asked"),
            listAssigneeCandidates: () => Effect.die("must not be called"),
          }),
        ],
      });
      const refusedHost = yield* Effect.flip(hostCannot.assigneeCandidates(REFERENCE));
      assert.include(refusedHost.message, "This host cannot say who may be assigned an issue.");

      const viewerMayNot = yield* makeService({
        projects: ONE_PROJECT,
        providers: [
          fakeProvider("github", {
            getViewerPermissions: () => Effect.succeed({ ...FULL_PERMISSIONS, assignees: false }),
            listAssigneeCandidates: () => Effect.die("must not be called"),
          }),
        ],
      });
      const refusedViewer = yield* Effect.flip(viewerMayNot.assigneeCandidates(REFERENCE));
      assert.include(
        refusedViewer.message,
        "You need write access on this repository to change who an issue is assigned to.",
      );
    }),
);

it.effect("hands the host's own candidate lists back, asked for with the issue", () =>
  Effect.gen(function* () {
    const asked: number[] = [];
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listLabelCandidates: ({ number }) => {
            asked.push(number);
            return Effect.succeed({
              candidates: [{ name: "bug", color: null, description: null, isApplied: true }],
              truncated: false,
            });
          },
          listAssigneeCandidates: ({ number }) => {
            asked.push(number);
            return Effect.succeed({
              candidates: [
                {
                  login: "bilal",
                  name: null,
                  avatarUrl: null,
                  id: "bilal",
                  isAssigned: false,
                },
              ],
              truncated: true,
            });
          },
        }),
      ],
    });

    const labels = yield* service.labelCandidates(REFERENCE);
    const assignees = yield* service.assigneeCandidates(REFERENCE);

    assert.deepStrictEqual(asked, [7, 7]);
    assert.deepStrictEqual(
      labels.candidates.map((candidate) => candidate.name),
      ["bug"],
    );
    assert.isTrue(assignees.truncated);
  }),
);

const REPOSITORY = { projectId: REFERENCE.projectId, repository: REFERENCE.repository };

const TEMPLATES: IssueTemplateList = {
  templates: [
    {
      key: "bug_report.md",
      name: "Bug report",
      about: "Something is broken",
      title: "[Bug]: ",
      body: "### What happened\n",
      labels: ["bug"],
      assignees: [],
    },
  ],
  contactLinks: [],
  blankIssuesEnabled: false,
};

/**
 * The host that offers no starting point is the one the composer most needs an answer from: it is
 * also the host that may take no labels, or no new issue at all. So an empty offer, with what the
 * host can do on it, rather than a refusal the form can read nothing out of.
 */
it.effect("tells a host with no templates apart by what it says it can do", () =>
  Effect.gen(function* () {
    const capabilities = { ...FULL_CAPABILITIES, issueTemplates: false, create: false };
    const hostCannot = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          capabilities,
          listIssueTemplates: () => Effect.die("must not be called"),
        }),
      ],
    });
    assert.deepStrictEqual(yield* hostCannot.templates(REPOSITORY), {
      capabilities,
      templates: [],
      contactLinks: [],
      blankIssuesEnabled: true,
    });

    // A host that claims the capability and implements nothing is the same empty offer rather than
    // a crash: the declaration is what the page believes, and it is the thing that was wrong.
    const undeclared = yield* makeService({
      projects: ONE_PROJECT,
      providers: [fakeProvider("github")],
    });
    assert.deepStrictEqual(yield* undeclared.templates(REPOSITORY), {
      capabilities: FULL_CAPABILITIES,
      templates: [],
      contactLinks: [],
      blankIssuesEnabled: true,
    });
  }),
);

/**
 * Nothing about the viewer is asked, unlike the candidate lists: this is the repository saying
 * what it wants filed, and everyone who can see the repository is told the same thing.
 */
it.effect("hands a repository's templates back without asking who is reading them", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewerPermissions: () => Effect.die("must not be asked"),
          listIssueTemplates: () => Effect.succeed(TEMPLATES),
        }),
      ],
    });

    // The host's own answer, with what the host can do added to it: a provider reports the offer,
    // the service is what knows the capabilities.
    assert.deepStrictEqual(yield* service.templates(REPOSITORY), {
      ...TEMPLATES,
      capabilities: FULL_CAPABILITIES,
    });
  }),
);

it.effect("asks the host for a repository's templates once, and again once told to forget", () =>
  Effect.gen(function* () {
    let hostCalls = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssueTemplates: () => {
            hostCalls += 1;
            return Effect.succeed(TEMPLATES);
          },
        }),
      ],
    });

    yield* Effect.all([service.templates(REPOSITORY), service.templates(REPOSITORY)], {
      concurrency: "unbounded",
    });
    yield* service.templates(REPOSITORY);
    assert.strictEqual(hostCalls, 1);

    // What a repository offers is changed by a commit to it, so one issue's own refresh leaves it
    // alone; only a reader asking for the whole page again spends the request.
    yield* service.invalidate({ reference: REFERENCE });
    yield* service.templates(REPOSITORY);
    assert.strictEqual(hostCalls, 1);

    yield* service.invalidate({});
    yield* service.templates(REPOSITORY);
    assert.strictEqual(hostCalls, 2);
  }),
);

it.effect("answers a repeated listing from cache, and concurrent readers share one request", () =>
  Effect.gen(function* () {
    let hostCalls = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: () => {
            hostCalls += 1;
            return Effect.succeed({
              items: [issue(7, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: false,
            });
          },
        }),
      ],
    });

    yield* Effect.all([service.list({ state: "open" }), service.list({ state: "open" })], {
      concurrency: "unbounded",
    });
    yield* service.list({ state: "open" });
    assert.strictEqual(hostCalls, 1);

    // A different filter is a different answer, not a cache hit.
    yield* service.list({ state: "all" });
    assert.strictEqual(hostCalls, 2);
  }),
);

it.effect("an explicit invalidation makes the next listing ask the host again", () =>
  Effect.gen(function* () {
    let hostCalls = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: () => {
            hostCalls += 1;
            return Effect.succeed({ items: [], truncated: false, continues: false });
          },
        }),
      ],
    });

    yield* service.list({ state: "open" });
    yield* service.invalidate({});
    yield* service.list({ state: "open" });
    assert.strictEqual(hostCalls, 2);

    // Forgetting one issue leaves the listings shared.
    yield* service.invalidate({ reference: REFERENCE });
    yield* service.list({ state: "open" });
    assert.strictEqual(hostCalls, 2);
  }),
);

it.effect("an explicit invalidation refreshes issue detail and activity", () =>
  Effect.gen(function* () {
    let detailVersion = 0;
    let activityVersion = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getIssue: () => {
            detailVersion += 1;
            return Effect.succeed(issueDetail(7, { body: `detail ${detailVersion}` }));
          },
          getIssueActivity: () => {
            activityVersion += 1;
            return Effect.succeed({
              comments: [],
              commentCount: activityVersion,
              commentsTruncated: false,
              events: [],
            });
          },
        }),
      ],
    });

    assert.strictEqual((yield* service.detail(REFERENCE)).body, "detail 1");
    assert.strictEqual((yield* service.activity(REFERENCE)).commentCount, 1);

    yield* service.invalidate({});

    assert.strictEqual((yield* service.detail(REFERENCE)).body, "detail 2");
    assert.strictEqual((yield* service.activity(REFERENCE)).commentCount, 2);
  }),
);

it.effect("a write forgets the listings and the issue it touched, with no client asking", () =>
  Effect.gen(function* () {
    let listCalls = 0;
    let detailCalls = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: () => {
            listCalls += 1;
            return Effect.succeed({ items: [], truncated: false, continues: false });
          },
          getIssue: () => {
            detailCalls += 1;
            return Effect.succeed(issueDetail(7));
          },
        }),
      ],
    });

    yield* service.list({ state: "open" });
    yield* service.detail(REFERENCE);
    assert.deepStrictEqual([listCalls, detailCalls], [1, 1]);

    yield* service.comment({ ...REFERENCE, body: "On it." });

    yield* service.list({ state: "open" });
    yield* service.detail(REFERENCE);
    assert.deepStrictEqual([listCalls, detailCalls], [2, 2]);
  }),
);

it.effect("a new issue forgets the listings that would hold it", () =>
  Effect.gen(function* () {
    let listCalls = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: () => {
            listCalls += 1;
            return Effect.succeed({ items: [], truncated: false, continues: false });
          },
        }),
      ],
    });

    yield* service.list({ state: "open" });
    const created = yield* service.create({
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      title: "It broke",
      body: "",
      labels: [],
      assignees: [],
    });
    yield* service.list({ state: "open" });

    assert.strictEqual(created.number, 1);
    assert.strictEqual(listCalls, 2);
  }),
);

/** A row as a host that reads several repositories at once hands it over. */
function batchedIssue(number: number, repository: string, updatedAt: string): ProviderBatchedIssue {
  return { ...issue(number, updatedAt), repository };
}

const TWO_PROJECTS = [
  project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
  project({ id: "p2", title: "api", workspaceRoot: "/b", repository: "acme/api" }),
];

it.effect("orders rows by the selected reaction kind across repositories", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: TWO_PROJECTS,
      providers: [
        fakeProvider("github", {
          listIssuesAcross: () =>
            Effect.succeed({
              items: [
                {
                  ...batchedIssue(1, "acme/web", "2026-07-05T00:00:00Z"),
                  reactions: [
                    { content: "thumbs-up", count: 9, actors: [], viewerHasReacted: false },
                    { content: "heart", count: 1, actors: [], viewerHasReacted: false },
                  ],
                },
                {
                  ...batchedIssue(2, "acme/api", "2026-07-02T00:00:00Z"),
                  reactions: [{ content: "heart", count: 3, actors: [], viewerHasReacted: false }],
                },
              ],
              truncated: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      sort: "reactions-heart",
      order: "desc",
    });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [2, 1],
    );
  }),
);

it.effect("reads a host's repositories in one search, and files the rows back under each", () =>
  Effect.gen(function* () {
    const asked: Array<ReadonlyArray<string>> = [];
    const service = yield* makeService({
      projects: TWO_PROJECTS,
      providers: [
        fakeProvider("github", {
          listIssues: () => Effect.die("must not be asked one at a time"),
          listIssuesAcross: (input) => {
            asked.push(input.repositories);
            return Effect.succeed({
              items: [
                batchedIssue(1, "acme/api", "2026-07-05T00:00:00Z"),
                batchedIssue(2, "acme/web", "2026-07-02T00:00:00Z"),
              ],
              truncated: false,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(asked, [["acme/web", "acme/api"]]);
    assert.deepStrictEqual(
      result.entries.map((entry) => [entry.projectId, entry.number]),
      [
        ["p2", 1],
        ["p1", 2],
      ],
    );
  }),
);

it.effect("asks on its own for a repository the search said nothing at all about", () =>
  Effect.gen(function* () {
    const separately: string[] = [];
    const service = yield* makeService({
      projects: TWO_PROJECTS,
      providers: [
        fakeProvider("github", {
          listIssues: ({ repository }) => {
            separately.push(repository);
            return Effect.succeed({
              items: [issue(9, "2026-07-01T00:00:00Z")],
              truncated: false,
              continues: true,
            });
          },
          listIssuesAcross: () =>
            Effect.succeed({
              items: [batchedIssue(1, "acme/web", "2026-07-05T00:00:00Z")],
              truncated: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    // A host does not index every repository for search, and a switched-off tracker is silent
    // too — so silence is checked once rather than believed.
    assert.deepStrictEqual(separately, ["acme/api"]);
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [1, 9],
    );
  }),
);

it.effect("reads the repositories one at a time when the search itself fails", () =>
  Effect.gen(function* () {
    const separately: string[] = [];
    const service = yield* makeService({
      projects: TWO_PROJECTS,
      providers: [
        fakeProvider("github", {
          listIssues: ({ repository }) => {
            separately.push(repository);
            return Effect.succeed({
              items: [issue(1, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            });
          },
          listIssuesAcross: () =>
            Effect.fail(
              new IssueProviderError({
                provider: "github",
                operation: "listIssuesAcross",
                reason: "failed",
                detail: "HTTP 422",
              }),
            ),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    // One failed question about two repositories is no reason to call both of them unreadable.
    assert.deepStrictEqual(separately.toSorted(), ["acme/api", "acme/web"]);
    assert.strictEqual(result.entries.length, 2);
    assert.deepStrictEqual(result.errors, []);
  }),
);

it.effect("carries every repository of a slice on from the oldest row in it", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: TWO_PROJECTS,
      providers: [
        fakeProvider("github", {
          listIssuesAcross: () =>
            Effect.succeed({
              items: [
                batchedIssue(1, "acme/web", "2026-07-05T00:00:00Z"),
                batchedIssue(2, "acme/web", "2026-07-03T00:00:00Z"),
              ],
              truncated: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      cursors: {
        [cursorKey("acme/web")]: "2026-07-06T00:00:00Z|1|1",
        [cursorKey("acme/api")]: "2026-07-06T00:00:00Z|1|5",
      },
    });

    // The repository that contributed nothing has been read to the same instant: its rows are
    // simply all older, and carrying it on from its own oldest row would say nothing about them.
    assert.deepStrictEqual(result.nextCursors, {
      [cursorKey("acme/web")]: "2026-07-03T00:00:00Z|0|2",
      [cursorKey("acme/api")]: "2026-07-03T00:00:00Z|0|",
    });
  }),
);

it.effect("passes a reaction through with its subject id", () =>
  Effect.gen(function* () {
    let received: Parameters<NonNullable<IssueAdapter["setReaction"]>>[0] | null = null;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          setReaction: (input) => {
            received = input;
            return Effect.void;
          },
        }),
      ],
    });

    yield* service.setReaction({
      ...REFERENCE,
      subjectId: "IC_1",
      content: "heart",
      reacted: true,
    });

    assert.deepStrictEqual(received, {
      cwd: "/a",
      repository: "acme/web",
      host: "github.com",
      number: 7,
      subjectId: "IC_1",
      content: "heart",
      reacted: true,
    });
  }),
);
