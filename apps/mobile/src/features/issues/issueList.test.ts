import { describe, expect, it, vi } from "vite-plus/test";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  SourceControlProviderKind,
  type IssueCapabilities,
  type IssueListEntry,
  type IssueListResult,
} from "@t3tools/contracts";
import {
  continueIssueListPage,
  issueEntryKey,
  refreshIssueListPage,
} from "@t3tools/client-runtime/state/issues";
import {
  createIssueSourceRefreshQueue,
  issueSourceRefreshQueue,
  heldIssueList,
  issueListControlsFor,
  issueListCanonicalSource,
  issueListPendingWrites,
  refreshWrittenIssueList,
  issueListTargetIncludesSource,
  issueWrites,
  markIssueWritten,
  issueCreateScopes,
  issueListNotices,
  issueListRows,
  issueListTrackers,
  scopedIssueKey,
} from "./issueList";

const environmentId = EnvironmentId.make("env-one");
const tracker = IssueTrackerKind.make("github");
const capabilities: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
  reactions: false,
  templates: true,
  linkedPullRequests: true,
  events: true,
  search: false,
  states: [],
  closeReasons: [],
};

function entry(key: string, patch: Partial<IssueListEntry> = {}): IssueListEntry {
  return {
    tracker,
    host: "github.com",
    scope: "org/repo",
    key,
    displayKey: `#${key}`,
    projectId: ProjectId.make("project"),
    projectTitle: "Project",
    title: `Issue ${key}`,
    url: `https://example.com/issues/${key}`,
    author: null,
    state: { category: "open", name: "Open" },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    ...patch,
  };
}

function answer(patch: Partial<IssueListResult> = {}): IssueListResult {
  return {
    entries: [],
    nextCursors: {},
    viewers: {},
    errors: [],
    trackers: [
      {
        tracker,
        host: "github.com",
        projectCount: 1,
        capabilities,
        configured: true,
        detail: null,
      },
    ],
    ...patch,
  };
}

const source = (result: IssueListResult, environment = environmentId) => ({
  environmentId: environment,
  held: heldIssueList(result),
});

describe("mobile issue list", () => {
  it("retains writes to different sources and each changed issue key while the list is unmounted", () => {
    const registry = AtomRegistry.make();
    const scope = {
      projectId: ProjectId.make("project"),
      tracker,
      host: "github.com",
      scope: "org/repo",
    };
    try {
      markIssueWritten(registry, environmentId, scope, "first-removed");
      markIssueWritten(registry, environmentId, {
        ...scope,
        projectId: ProjectId.make("other"),
        scope: "org/other",
      });
      markIssueWritten(registry, environmentId, scope, "second-removed");
      const writes = registry.get(issueWrites)!;
      expect(writes.revision).toBe(3);
      const dirty = [...writes.sources.values()];
      expect(dirty.map((write) => [write.source.projectId, write.revision])).toEqual([
        [scope.projectId, 3],
        [ProjectId.make("other"), 2],
      ]);
      expect([...dirty[0]!.removedKeys.keys()]).toEqual(["first-removed", "second-removed"]);
      expect([...dirty[1]!.removedKeys.keys()]).toEqual([]);
    } finally {
      registry.dispose();
    }
  });

  it.each([undefined, 1])(
    "retains writes and increasing revisions after release and idle TTL %s",
    async (defaultIdleTTL) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const registry = AtomRegistry.make({ defaultIdleTTL, timeoutResolution: 1 });
      const scope = {
        projectId: ProjectId.make("project"),
        tracker,
        host: "github.com",
        scope: "org/repo",
      };
      const ledger = Atom.make(1).pipe(Atom.setIdleTTL(5 * 60_000));
      const releaseLedger = registry.mount(ledger);
      try {
        const release = registry.mount(issueWrites);
        markIssueWritten(registry, environmentId, scope, "51");
        const before = registry.get(issueWrites);
        release();
        await new Promise<void>((resolve) => setImmediate(resolve));
        const remount = registry.mount(issueWrites);
        expect(registry.get(issueWrites)).toBe(before);
        remount();
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
        markIssueWritten(registry, environmentId, scope, "52");
        await new Promise<void>((resolve) => setImmediate(resolve));
        const releaseAgain = registry.mount(issueWrites);
        expect(registry.get(issueWrites)!.revision).toBeGreaterThan(registry.get(ledger));
        expect(registry.get(issueWrites)!.revision).toBe(2);
        expect([...registry.get(issueWrites)!.sources.values()][0]!.removedKeys.size).toBe(1);
        releaseAgain();
      } finally {
        releaseLedger();
        registry.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("expires old dirty sources and changed keys after the held-cache lifetime", () => {
    const registry = AtomRegistry.make();
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const scope = {
      projectId: ProjectId.make("project"),
      tracker,
      host: "github.com",
      scope: "org/repo",
    };
    try {
      markIssueWritten(registry, environmentId, scope, "old-key");
      markIssueWritten(registry, environmentId, { ...scope, scope: "org/other" });
      now.mockReturnValue(5 * 60_000 + 1);
      markIssueWritten(registry, environmentId, scope, "new-key");
      const writes = registry.get(issueWrites)!;
      expect(writes.revision).toBe(3);
      expect(writes.sources.size).toBe(1);
      expect([...writes.sources.values()][0]!.removedKeys).toEqual(
        new Map([["new-key", 5 * 60_000 + 1]]),
      );
    } finally {
      now.mockRestore();
      registry.dispose();
    }
  });

  it("finishes the active source read before running only the newest queued read", async () => {
    const queue = createIssueSourceRefreshQueue();
    const reads: string[] = [];
    let finishFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const active = queue("source", async () => {
      reads.push("first");
      await firstRead;
    });
    await Promise.resolve();
    const skipped = queue("source", async () => {
      reads.push("second");
    });
    const newest = queue("source", async () => {
      reads.push("newest");
    });
    await queue("other-source", async () => {
      reads.push("other");
    });
    expect(reads).toEqual(["first", "other"]);
    finishFirst();
    await Promise.all([active, skipped, newest]);
    expect(reads).toEqual(["first", "other", "newest"]);
    await queue("source", async () => {
      reads.push("next-write");
    });
    expect(reads).toEqual(["first", "other", "newest", "next-write"]);
  });

  it("runs a source retry queued from within the active read after that read ends", async () => {
    const queue = createIssueSourceRefreshQueue();
    const reads: string[] = [];
    await queue("source", async () => {
      reads.push("stale");
      void queue("source", async () => {
        reads.push("fresh");
      });
      expect(reads).toEqual(["stale"]);
    });
    expect(reads).toEqual(["stale", "fresh"]);
  });

  it("keeps queued source reads separate for lists with different filters", async () => {
    const registry = AtomRegistry.make();
    const key = (state: "open" | "closed") => JSON.stringify([{ environmentId, input: { state } }]);
    const reads: string[] = [];
    const gate = Promise.withResolvers<void>();
    try {
      const open = registry.get(issueSourceRefreshQueue(key("open")));
      const closed = registry.get(issueSourceRefreshQueue(key("closed")));
      const active = open("source", async () => {
        reads.push("open");
        await gate.promise;
      });
      await Promise.resolve();
      const queued = open("source", async () => {
        reads.push("open-refresh");
      });
      await closed("source", async () => {
        reads.push("closed-refresh");
      });
      expect(reads).toEqual(["open", "closed-refresh"]);
      gate.resolve();
      await Promise.all([active, queued]);
      expect(reads).toEqual(["open", "closed-refresh", "open-refresh"]);
    } finally {
      gate.resolve();
      registry.dispose();
    }
  });

  it("refreshes a written source only in lists with compatible environment, project, and host filters", () => {
    const row = entry("1");
    const input = { state: "open" as const, involvement: "assigned" as const, query: "fix" };
    const targets = [
      { environmentId, input },
      { environmentId, input: { ...input, projectId: row.projectId, host: "GITHUB.COM" } },
      { environmentId, input: { ...input, projectId: ProjectId.make("other") } },
      { environmentId, input: { ...input, host: "gitlab.com" } },
      { environmentId: EnvironmentId.make("env-two"), input },
    ];
    const selected = targets.filter((target) =>
      issueListTargetIncludesSource(target, environmentId, row),
    );
    expect(selected).toEqual(targets.slice(0, 2));
    expect(
      issueListTargetIncludesSource(targets[1]!, environmentId, { ...row, host: undefined }),
    ).toBe(false);
  });

  it("restores controls and drops both project fields when their environment or project is stale", () => {
    const environmentIds = [environmentId, EnvironmentId.make("env-two")];
    const saved = {
      environmentId: null,
      state: "closed" as const,
      involvement: "assigned" as const,
      host: "github.com",
      projectId: "project",
      projectEnvironmentId: environmentId,
    };
    expect(issueListControlsFor(undefined, environmentIds, [project()])).toEqual({
      environmentId: null,
      state: "open",
      involvement: "all",
    });
    expect(issueListControlsFor(saved, environmentIds, [project()])).toEqual(saved);
    expect(issueListControlsFor({ ...saved, environmentId }, environmentIds, [project()])).toEqual({
      ...saved,
      environmentId,
    });
    const withoutProject = {
      environmentId: null,
      state: saved.state,
      involvement: saved.involvement,
      host: saved.host,
    };
    expect(
      issueListControlsFor({ ...saved, environmentId: "env-two" }, environmentIds, [project()]),
    ).toEqual({ ...withoutProject, environmentId: "env-two" });
    expect(issueListControlsFor(saved, ["env-two"], [project()])).toEqual(withoutProject);
    expect(issueListControlsFor(saved, environmentIds, [])).toEqual(withoutProject);
    expect(
      issueListControlsFor(saved, environmentIds, [
        { ...project(), environmentId: EnvironmentId.make("env-two") },
      ]),
    ).toEqual(withoutProject);
    expect(
      issueListControlsFor({ ...saved, environmentId: "removed" }, environmentIds, [project()]),
    ).toEqual(withoutProject);
    expect(
      issueListControlsFor({ ...saved, projectId: undefined }, environmentIds, [project()]),
    ).toEqual(withoutProject);
    expect(
      issueListControlsFor({ ...saved, projectEnvironmentId: undefined }, environmentIds, [
        project(),
      ]),
    ).toEqual(withoutProject);
    expect(saved.projectId).toBe("project");
  });

  it("narrows creation to the selected project and environment for server sources and the fallback", () => {
    const selected = { environmentId, projectId: "selected" };
    const common = { tracker, host: "github.com", scope: "org/repo", capabilities };
    const otherEnvironment = EnvironmentId.make("env-two");
    const selectedProject = { ...project(), id: ProjectId.make("selected"), title: "Selected" };
    const lists = [
      source(
        answer({
          sources: [
            { ...common, projectId: ProjectId.make("other"), projectTitle: "Other" },
            { ...common, projectId: selectedProject.id, projectTitle: "Selected" },
          ],
        }),
      ),
      source(
        answer({
          sources: [
            { ...common, projectId: selectedProject.id, projectTitle: "Other environment" },
          ],
        }),
        otherEnvironment,
      ),
    ];
    expect(
      issueCreateScopes(lists, [], selected).map((scope) => [
        scope.environmentId,
        scope.scope.projectId,
      ]),
    ).toEqual([[environmentId, selectedProject.id]]);
    expect(
      issueCreateScopes(
        [source(answer()), source(answer(), otherEnvironment)],
        [project(), selectedProject, { ...selectedProject, environmentId: otherEnvironment }],
        selected,
      ).map((scope) => [scope.environmentId, scope.scope.projectId]),
    ).toEqual([[environmentId, selectedProject.id]]);
    expect(issueCreateScopes(lists, [], { ...selected, projectId: "missing" })).toEqual([]);
    expect(
      issueListRows(
        [source(answer({ entries: [entry("1", { projectId: selectedProject.id })] }))],
        "",
      )[0]?.projectId,
    ).toBe(selectedProject.id);
  });

  it("narrows only trackers without search, by title or display key, and keeps environments distinct", () => {
    const local = source(
      answer({ entries: [entry("1", { title: "Fix INPUT", host: "GITHUB.COM" }), entry("2")] }),
    );
    const remote = source(
      answer({
        entries: [entry("1", { title: "Server match", updatedAt: "2026-10-02T00:00:00Z" })],
        trackers: [{ ...answer().trackers[0]!, capabilities: { ...capabilities, search: true } }],
      }),
      EnvironmentId.make("env-two"),
    );
    const rows = issueListRows([local, remote], "input");
    expect(rows.map((row) => row.title)).toEqual(["Server match", "Fix INPUT"]);
    expect(scopedIssueKey(rows[0]!)).not.toBe(scopedIssueKey(rows[1]!));
    expect(issueListRows([local], "#2").map((row) => row.key)).toEqual(["2"]);
    expect(issueListRows([local, remote], "")).toHaveLength(3);
  });

  it("shows project failures and unconfigured trackers once with stable keys", () => {
    const error = {
      projectId: ProjectId.make("project"),
      projectTitle: "Project",
      message: "Read failed",
    };
    const unavailable = { ...answer().trackers[0]!, configured: false, detail: null };
    const list = source(answer({ errors: [error, error], trackers: [unavailable, unavailable] }));
    const notices = issueListNotices([list]);
    expect(notices.map(({ title, message }) => ({ title, message }))).toEqual([
      { title: "Project", message: "Read failed" },
      { title: "github.com", message: "This tracker cannot be read right now." },
    ]);
    expect(new Set(notices.map((notice) => notice.key)).size).toBe(2);
    expect(issueListNotices([list])).toEqual(notices);
    expect(
      issueListNotices([list, source(list.held.answer, EnvironmentId.make("env-two"))]),
    ).toHaveLength(4);
    expect(
      issueListNotices([source(answer({ trackers: [{ ...unavailable, detail: "Sign in" }] }))])[0]
        ?.message,
    ).toBe("Sign in");
  });

  it("deduplicates tracker accounts by kind and case-insensitive host, prefers configured, and sorts", () => {
    const configured = answer().trackers[0]!;
    const lists = [
      source(
        answer({
          trackers: [
            { ...configured, host: "GITHUB.COM", configured: false },
            { ...configured, host: "z.example" },
          ],
        }),
      ),
      source(answer(), EnvironmentId.make("env-two")),
    ];
    expect(issueListTrackers(lists)).toEqual([configured, { ...configured, host: "z.example" }]);
  });

  it("uses server sources first, skips unavailable or non-create sources, and deduplicates scopes", () => {
    const scope = {
      projectId: ProjectId.make("project"),
      projectTitle: "Team",
      tracker,
      host: "github.com",
      scope: "org/repo",
      capabilities: { ...capabilities, createIssueTypes: true },
    };
    const lists = [
      source(
        answer({
          sources: [
            scope,
            {
              ...scope,
              projectId: ProjectId.make("duplicate"),
              host: "GITHUB.COM",
              scope: "ORG/REPO",
            },
            {
              ...scope,
              scope: "org/readonly",
              capabilities: { ...capabilities, create: false },
            },
          ],
        }),
      ),
    ];
    expect(issueCreateScopes(lists, [])).toEqual([
      {
        environmentId,
        projectTitle: "Team",
        templates: true,
        createIssueTypes: true,
        scope: { projectId: scope.projectId, tracker, host: scope.host, scope: scope.scope },
      },
    ]);
    expect(
      issueCreateScopes(
        [
          source(
            answer({
              sources: [scope],
              trackers: [{ ...answer().trackers[0]!, configured: false }],
            }),
          ),
        ],
        [],
      ),
    ).toEqual([]);
    expect(issueCreateScopes([source(answer({ sources: [] }))], [project()])).toEqual([]);
  });

  it("creates through the current representative after continuing a deleted project source", () => {
    const original = {
      projectId: ProjectId.make("A"),
      projectTitle: "A",
      tracker,
      host: "github.com",
      scope: "org/repo",
      capabilities,
    };
    const current = { ...original, projectId: ProjectId.make("B"), projectTitle: "B" };
    const initial = heldIssueList(
      answer({ sources: [original], nextCursors: { "github.com org/repo": "50" } }),
    );
    const held = continueIssueListPage(
      initial,
      initial.nextCursors,
      answer({ entries: [entry("51", current)], sources: [current] }),
      initial.firstCursors,
    );
    const lists = [{ environmentId, held }];
    const expected = [
      {
        environmentId,
        projectTitle: "B",
        templates: true,
        scope: { projectId: current.projectId, tracker, host: current.host, scope: current.scope },
      },
    ];
    expect(issueCreateScopes(lists, [])).toEqual(expected);
    expect(issueCreateScopes(lists, [], { environmentId, projectId: "B" })).toEqual(expected);
    expect(issueCreateScopes(lists, [], { environmentId, projectId: "A" })).toEqual([]);
  });

  it("uses current projects after an older-server continuation without source metadata", () => {
    const initial = heldIssueList(answer({ nextCursors: { "github.com org/repo": "50" } }));
    const held = continueIssueListPage(
      initial,
      initial.nextCursors,
      answer({ entries: [entry("51", { projectId: ProjectId.make("B"), projectTitle: "B" })] }),
      initial.firstCursors,
    );
    const current = { ...project(), id: ProjectId.make("B"), title: "B" };
    expect(held.sources).toBeUndefined();
    expect(
      issueCreateScopes([{ environmentId, held }], [current], { environmentId, projectId: "B" }),
    ).toEqual([
      {
        environmentId,
        projectTitle: "B",
        templates: true,
        scope: { projectId: current.id, tracker, host: "github.com", scope: "org/repo" },
      },
    ]);
  });

  it.each([
    ["linear", "linear.app", "ENG"],
    ["jira", "acme.atlassian.net", "WEB"],
  ])("uses listed %s scopes on older servers without a repository", (kind, host, scope) => {
    const standalone = { ...project(), repositoryIdentity: null };
    const nativeTracker = IssueTrackerKind.make(kind);
    const listed = entry("1", { tracker: nativeTracker, host, scope });
    const nativeAnswer = answer({
      entries: [listed, { ...listed, key: "2" }],
      trackers: [
        {
          ...answer().trackers[0]!,
          tracker: nativeTracker,
          host: host.toUpperCase(),
          capabilities: { ...capabilities, templates: false, createIssueTypes: true },
        },
      ],
    });
    const lists = [source(nativeAnswer)];
    const selected = { environmentId, projectId: standalone.id };
    const otherEnvironment = EnvironmentId.make("env-two");
    const expected = [
      {
        environmentId,
        projectTitle: standalone.title,
        templates: false,
        createIssueTypes: true,
        scope: { projectId: standalone.id, tracker: nativeTracker, host, scope },
      },
    ];
    expect(issueCreateScopes(lists, [standalone])).toEqual(expected);
    expect(issueCreateScopes(lists, [standalone], selected)).toEqual(expected);
    expect(issueCreateScopes([source({ ...nativeAnswer, sources: [] })], [standalone])).toEqual([]);
    expect(issueCreateScopes([source({ ...nativeAnswer, entries: [] })], [project()])).toEqual([]);
    expect(issueCreateScopes(lists, [standalone], { ...selected, projectId: "other" })).toEqual([]);
    expect(issueCreateScopes(lists, [{ ...standalone, environmentId: otherEnvironment }])).toEqual(
      [],
    );
    expect(
      issueCreateScopes(lists, [standalone], {
        ...selected,
        environmentId: otherEnvironment,
      }),
    ).toEqual([]);
    expect(issueCreateScopes(lists, [{ ...standalone, id: ProjectId.make("foreign") }])).toEqual(
      [],
    );
  });

  it.each([
    { configured: false },
    { capabilities: { ...capabilities, create: false } },
    { capabilities: null },
    { tracker: IssueTrackerKind.make("jira") },
    { host: "foreign.example" },
  ])("rejects old-server native scopes without matching create access: %j", (patch) => {
    const listed = entry("ENG-1", {
      tracker: IssueTrackerKind.make("linear"),
      host: "linear.app",
      scope: "ENG",
    });
    const summary = {
      ...answer().trackers[0]!,
      tracker: listed.tracker,
      host: listed.host,
      ...patch,
    };
    const lists = [source(answer({ entries: [listed], trackers: [summary] }))];
    expect(issueCreateScopes(lists, [{ ...project(), repositoryIdentity: null }])).toEqual([]);
  });

  it("falls back to same-environment repository identities and requires a configured create capability", () => {
    const projects = [
      project(),
      { ...project(), id: ProjectId.make("duplicate") },
      { ...project(), environmentId: EnvironmentId.make("env-two") },
      { ...project(), repositoryIdentity: null },
    ];
    expect(issueCreateScopes([source(answer())], projects)).toEqual([
      {
        environmentId,
        projectTitle: "Project",
        templates: true,
        scope: {
          projectId: ProjectId.make("project"),
          tracker,
          host: "github.com",
          scope: "org/repo",
        },
      },
    ]);
    for (const patch of [
      { configured: false },
      { capabilities: { ...capabilities, create: false } },
      { capabilities: null },
    ])
      expect(
        issueCreateScopes(
          [source(answer({ trackers: [{ ...answer().trackers[0]!, ...patch }] }))],
          projects,
        ),
      ).toEqual([]);
  });

  it.each([
    ["dev.azure.com", "acme/Web App/_git/web", "acme/Web App"],
    ["dev.azure.com", "acme/Web%20App/_git/web", "acme/Web App"],
    ["dev.azure.com", "acme/Web%2520App/_git/web", "acme/Web%20App"],
    ["acme.visualstudio.com", "Web App/_git/web", "acme/Web App"],
    ["acme.visualstudio.com", "DefaultCollection/Web%20App/_git/web", "acme/Web App"],
    ["Acme.VISUALSTUDIO.COM:8443", "Web%20App/_git/web", "acme/Web App"],
    ["dev.azure.com:8443", "acme/Web%20App/_git/web", "acme/Web App"],
    ["dev.azure.com", "web", null],
    ["dev.azure.com", "acme/_git/web", null],
    ["dev.azure.com", "acme/Web%2FApp/_git/web", null],
    ["dev.azure.com", "acme/Web%5CApp/_git/web", null],
    ["dev.azure.com", "acme/Web%ZZApp/_git/web", null],
    ["dev.azure.com", "acme/Web App/_git", null],
    ["acme.visualstudio.com", "acme/Web App/_git/web", null],
  ])("uses the older-server Azure issue scope for %s/%s", (host, displayName, scope) => {
    const base = project();
    const azureTracker = {
      ...answer().trackers[0]!,
      tracker: IssueTrackerKind.make("azure-devops"),
      host,
    };
    const azureProject = {
      ...base,
      repositoryIdentity: {
        ...base.repositoryIdentity,
        provider: SourceControlProviderKind.make("azure-devops"),
        canonicalKey: `${host}/${displayName}`,
        displayName,
        owner: "acme",
        name: "web",
        locator: {
          ...base.repositoryIdentity.locator,
          remoteUrl: `https://${host}/${displayName}`,
        },
      },
    };
    expect(
      issueCreateScopes([source(answer({ trackers: [azureTracker] }))], [azureProject]),
    ).toEqual(
      scope === null
        ? []
        : [
            {
              environmentId,
              projectTitle: "Project",
              templates: true,
              scope: {
                projectId: azureProject.id,
                tracker: azureTracker.tracker,
                host: host.toLowerCase(),
                scope,
              },
            },
          ],
    );
  });
});

function project() {
  return {
    environmentId,
    id: ProjectId.make("project"),
    title: "Project",
    repositoryIdentity: {
      provider: SourceControlProviderKind.make("github"),
      canonicalKey: "github.com/org/repo",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://example.com/org/repo.git",
      },
      displayName: "org/repo",
      owner: "org",
      name: "repo",
    },
  };
}

describe("held issue pages", () => {
  const cursorKey = "github.com org/repo";

  it("refreshes an alias write through the held representative and removes its canonical tail key", () => {
    const registry = AtomRegistry.make();
    const canonical = {
      projectId: ProjectId.make("A"),
      tracker,
      host: "github.com",
      scope: "org/repo",
    };
    const alias = { ...canonical, projectId: ProjectId.make("B") };
    const head = answer({ entries: [entry("1", canonical)], nextCursors: { [cursorKey]: "50" } });
    const first = heldIssueList(head);
    const loaded = continueIssueListPage(
      first,
      first.nextCursors,
      answer({ entries: [entry("51", canonical)], nextCursors: { [cursorKey]: "100" } }),
      first.firstCursors,
    );
    try {
      markIssueWritten(registry, environmentId, alias, "51");
      const writes = registry.get(issueWrites)!.sources;
      const target = { environmentId, input: { state: "open" as const } };
      expect(issueListCanonicalSource(loaded, alias)).toEqual(canonical);
      expect(
        issueListTargetIncludesSource(
          { ...target, input: { ...target.input, projectId: canonical.projectId } },
          environmentId,
          alias,
          loaded,
        ),
      ).toBe(true);
      const refreshed = refreshWrittenIssueList(loaded, head, writes, canonical);
      expect(refreshed.held.entries.map((row) => [row.projectId, row.key])).toEqual([
        [canonical.projectId, "1"],
      ]);
      expect(refreshed.held.nextCursors).toEqual({ [cursorKey]: "100" });
      expect(refreshed.handledWrites.size).toBe(1);
      markIssueWritten(registry, environmentId, canonical, "52");
      expect(registry.get(issueWrites)!.sources.size).toBe(1);
      expect([...registry.get(issueWrites)!.sources.values()][0]!.removedKeys.size).toBe(2);
    } finally {
      registry.dispose();
    }
  });

  it("keeps failed alias writes pending through expiry for a manual refresh of the held tail", () => {
    const registry = AtomRegistry.make();
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const canonical = {
      projectId: ProjectId.make("A"),
      tracker,
      host: "github.com",
      scope: "org/repo",
    };
    const alias = { ...canonical, projectId: ProjectId.make("B") };
    const head = answer({ entries: [entry("1", canonical)], nextCursors: { [cursorKey]: "50" } });
    const first = heldIssueList(head);
    const loaded = continueIssueListPage(
      first,
      first.nextCursors,
      answer({ entries: [entry("51", canonical)], nextCursors: { [cursorKey]: "100" } }),
      first.firstCursors,
    );
    try {
      markIssueWritten(registry, environmentId, alias, "51");
      const failed = refreshWrittenIssueList(
        loaded,
        answer({
          errors: [
            {
              projectId: canonical.projectId,
              host: canonical.host,
              projectTitle: "A",
              message: "Quota",
            },
          ],
        }),
        registry.get(issueWrites)!.sources,
        canonical,
      );
      expect(failed.held.entries).toEqual(loaded.entries);
      expect(failed.held.nextCursors).toEqual(loaded.nextCursors);
      expect(failed.handledWrites.size).toBe(0);
      expect([...failed.held.pendingWrites.values()][0]!.failed).toBe(true);
      now.mockReturnValue(5 * 60_000 + 1);
      markIssueWritten(registry, environmentId, alias, "52");
      const target = { environmentId, input: { state: "open" as const } };
      const pending = issueListPendingWrites(
        target,
        failed.held,
        registry.get(issueWrites)!.sources,
        new Map(),
      );
      expect([...pending.values()][0]!.removedKeys.size).toBe(2);
      const retried = refreshWrittenIssueList(failed.held, head, pending);
      expect(retried.held.entries.map((row) => row.key)).toEqual(["1"]);
      expect(retried.held.nextCursors).toEqual(loaded.nextCursors);
      expect(retried.held.errors).toEqual([]);
      expect(retried.held.pendingWrites.size).toBe(0);
      expect(retried.handledWrites.size).toBe(1);
    } finally {
      now.mockRestore();
      registry.dispose();
    }
  });

  it("removes both changed tail issues while retaining fresh matching rows and failed-source rows", () => {
    const held = heldIssueList(
      answer({ entries: [entry("1")], nextCursors: { [cursorKey]: "first" } }),
    );
    const loaded = continueIssueListPage(
      held,
      held.nextCursors,
      answer({ entries: [entry("2"), entry("3")], nextCursors: { [cursorKey]: "second" } }),
      held.firstCursors,
    );
    const removed = new Set([issueEntryKey(entry("2")), issueEntryKey(entry("3"))]);
    const scope = { projectId: entry("1").projectId, host: "github.com", scope: "org/repo" };
    const fresh = answer({ entries: [entry("1")], nextCursors: { [cursorKey]: "first" } });
    expect(
      refreshIssueListPage(loaded, fresh, { source: scope, removed }).entries.map((row) => row.key),
    ).toEqual(["1"]);
    expect(
      refreshIssueListPage(
        loaded,
        { ...fresh, entries: [entry("2")] },
        { source: scope, removed },
      ).entries.map((row) => row.key),
    ).toEqual(["2"]);
    const failed = answer({
      errors: [
        { projectId: scope.projectId, projectTitle: "Project", host: scope.host, message: "Down" },
      ],
    });
    const kept = refreshIssueListPage(loaded, failed, { source: scope, removed });
    expect(kept.entries).toEqual(loaded.entries);
    expect(kept.nextCursors).toEqual(loaded.nextCursors);
  });

  it("acknowledges a write when another tracker on the same host fails", () => {
    const issue = entry("1");
    const scope = {
      projectId: issue.projectId,
      tracker: issue.tracker,
      host: issue.host,
      scope: issue.scope,
    };
    const writes = new Map([
      [
        "write",
        {
          revision: 1,
          environmentId,
          source: scope,
          removedKeys: new Map<string, number>(),
          updatedAt: Date.now(),
        },
      ],
    ]);
    const fresh = answer({
      entries: [issue],
      errors: [
        {
          projectId: issue.projectId,
          projectTitle: issue.projectTitle,
          tracker: IssueTrackerKind.make("gitlab"),
          host: issue.host,
          message: "Down",
        },
      ],
    });
    const refreshed = refreshWrittenIssueList(heldIssueList(answer()), fresh, writes, scope);
    expect(refreshed.handledWrites.get("write")).toBe(1);
    expect(refreshed.held.pendingWrites.size).toBe(0);
  });

  it("keeps a continued tail on refresh and drops an in-flight page from the old first cursors", () => {
    const head = answer({ entries: [entry("1")], nextCursors: { [cursorKey]: "first" } });
    const initial = heldIssueList(head);
    const continued = continueIssueListPage(
      initial,
      initial.nextCursors,
      answer({ entries: [entry("2")], nextCursors: { [cursorKey]: "second" } }),
      initial.firstCursors,
    );
    const fresh = answer({
      entries: [entry("1", { title: "Updated" })],
      nextCursors: { [cursorKey]: "fresh-first" },
    });
    const refreshed = { ...refreshIssueListPage(continued, fresh), answer: fresh };
    expect(refreshed.entries.map((row) => row.title)).toEqual(["Issue 2", "Updated"]);
    expect(refreshed.nextCursors).toEqual({ [cursorKey]: "second" });
    expect(refreshed.answer).toBe(fresh);
    expect(
      continueIssueListPage(
        refreshed,
        continued.nextCursors,
        answer({ entries: [entry("3")] }),
        continued.firstCursors,
      ),
    ).toBe(refreshed);
    expect(
      continueIssueListPage(
        continued,
        { [cursorKey]: "wrong" },
        answer({ entries: [entry("3")] }),
        continued.firstCursors,
      ),
    ).toBe(continued);
  });

  it("keeps failed source cursors for retry, merges successful rows, and clears errors after retry", () => {
    const initial = heldIssueList(
      answer({
        entries: [entry("1")],
        nextCursors: { [cursorKey]: "first", "github.com org/other": "other-first" },
      }),
    );
    const failed = continueIssueListPage(
      initial,
      initial.nextCursors,
      answer({
        entries: [entry("2", { projectId: ProjectId.make("other"), scope: "org/other" })],
        errors: [
          {
            projectId: ProjectId.make("project"),
            projectTitle: "Project",
            host: "github.com",
            message: "Quota",
          },
        ],
      }),
      initial.firstCursors,
    );
    expect(failed.entries).toHaveLength(2);
    expect(failed.nextCursors).toEqual({ [cursorKey]: "first" });
    const retried = continueIssueListPage(
      failed,
      failed.nextCursors,
      answer({ entries: [entry("3")] }),
      failed.firstCursors,
    );
    expect(retried.entries).toHaveLength(3);
    expect(retried.errors).toEqual([]);
    expect(retried.nextCursors).toEqual({});
  });
});

it("keeps native Forgejo mounts separate for creation, write refresh and project filters", () => {
  const upper = entry("42", {
    tracker: IssueTrackerKind.make("forgejo"),
    host: "forgejo.test",
    scope: "Mount/Acme/Web",
    projectId: ProjectId.make("upper"),
  });
  const lower = entry("42", {
    ...upper,
    scope: "mount/Acme/Web",
    projectId: ProjectId.make("lower"),
  });
  const held = heldIssueList(
    answer({
      entries: [upper, lower],
      trackers: [],
      sources: [upper, lower].map((row) => ({ ...row, capabilities })),
    }),
  );
  expect(
    issueCreateScopes([{ environmentId, held }], []).map((item) => item.scope.projectId),
  ).toEqual(["upper", "lower"]);
  expect(issueListCanonicalSource(held, lower).projectId).toBe("lower");
  const target = { environmentId, input: { state: "open" as const, projectId: upper.projectId } };
  expect(issueListTargetIncludesSource(target, environmentId, lower, held)).toBe(false);
  expect(
    issueListTargetIncludesSource(
      target,
      environmentId,
      { ...upper, projectId: ProjectId.make("alias"), scope: "Mount/acme/web" },
      held,
    ),
  ).toBe(true);
  const registry = AtomRegistry.make();
  try {
    markIssueWritten(registry, environmentId, upper, "42");
    markIssueWritten(registry, environmentId, lower, "43");
    expect(
      [...registry.get(issueWrites)!.sources.values()].map((write) => [
        write.source.projectId,
        [...write.removedKeys.keys()],
      ]),
    ).toEqual([
      ["upper", ["42"]],
      ["lower", ["43"]],
    ]);
  } finally {
    registry.dispose();
  }
});
