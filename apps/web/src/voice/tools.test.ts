import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationSearchThreadsResult,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  type ServerConfig,
  type ServerProvider,
  type VoiceThreadSearchMatch,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  classifyEnvironmentFailure,
  createVoiceToolExecutor,
  evaluateModelAvailability,
  projectThreadTurns,
  splitSearchTerms,
  VoiceEnvironmentAccessError,
  VoiceToolFailureError,
  type VoiceEnvironmentAccess,
  type VoiceEnvironmentCatalogEntry,
  type VoiceToolHost,
} from "./tools";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const threadArchived = ThreadId.make("thread-archived");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const runA = RunId.make("run-a");

const modelSelection = { instanceId: "inst-a", model: "model-a" } as ModelSelection;
const now = DateTime.makeUnsafe("2026-09-02T10:00:00.000Z");
const providerInstanceId = ProviderInstanceId.make("inst-a");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function threadShell(
  overrides: Partial<OrchestrationV2ThreadShell> & {
    id: OrchestrationV2ThreadShell["id"];
    title: string;
  },
): OrchestrationV2ThreadShell {
  return {
    projectId: projectA,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: overrides.id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function projectShell(
  overrides: Partial<OrchestrationProjectShell> & { id: OrchestrationProjectShell["id"] },
): OrchestrationProjectShell {
  return {
    title: "Oracle",
    workspaceRoot: "/tmp/oracle",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-02T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

function shellSnapshot(
  threads: OrchestrationV2ThreadShell[],
  projects: OrchestrationProjectShell[] = [],
  archivedThreads: OrchestrationV2ThreadShell[] = [],
): OrchestrationV2ShellSnapshot {
  return {
    schemaVersion: 1,
    snapshotSequence: 7,
    projects,
    threads,
    archivedThreads,
  };
}

function run(
  overrides: Partial<OrchestrationV2Run> & {
    id?: OrchestrationV2Run["id"];
    status?: OrchestrationV2Run["status"];
  },
): OrchestrationV2Run {
  return {
    id: runA,
    threadId: threadA,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("msg-1"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "running",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    ...overrides,
  };
}

function projection(
  overrides: Partial<OrchestrationV2ThreadProjection> & {
    id?: OrchestrationV2ThreadProjection["thread"]["id"];
    title?: string;
  },
): OrchestrationV2ThreadProjection {
  const threadId = overrides.id ?? threadA;
  return {
    thread: {
      id: threadId,
      projectId: projectA,
      title: overrides.title ?? "Thread",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
    ...overrides,
  };
}

function detailSnapshot(
  threadProjection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadDetailSnapshot {
  return { snapshotSequence: 11, projection: threadProjection };
}

function message(
  overrides: Partial<OrchestrationV2ConversationMessage> & {
    role: OrchestrationV2ConversationMessage["role"];
    text: string;
  },
): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make("msg-1"),
    createdBy: "user",
    creationSource: "web",
    threadId: threadA,
    runId: null,
    nodeId: null,
    streaming: false,
    createdAt: now,
    updatedAt: now,
    attachments: [],
    ...overrides,
  };
}

function serverProvider(
  overrides: { instanceId: string } & Omit<Partial<ServerProvider>, "instanceId">,
): ServerProvider {
  const { instanceId, ...rest } = overrides;
  return {
    driver: "claude" as ServerProvider["driver"],
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-02T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    instanceId: instanceId as ServerProvider["instanceId"],
    ...rest,
  };
}

function searchResult(
  matches: OrchestrationSearchThreadsResult["matches"],
): OrchestrationSearchThreadsResult {
  return { matches };
}

function searchMatch(
  overrides: Partial<OrchestrationSearchThreadsResult["matches"][number]> & { threadId: ThreadId },
): OrchestrationSearchThreadsResult["matches"][number] {
  return {
    projectId: projectA,
    source: "user",
    snippet: "snippet",
    messageCreatedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

function catalogEntry(
  overrides: Partial<VoiceEnvironmentCatalogEntry> & { environmentId: EnvironmentId },
): VoiceEnvironmentCatalogEntry {
  return {
    label: overrides.environmentId,
    connectionState: "connected",
    isPrimary: false,
    voiceLiveCapable: false,
    scopes: ["orchestration:read", "orchestration:operate"],
    ...overrides,
  };
}

function accessMock(overrides: Partial<VoiceEnvironmentAccess> = {}): VoiceEnvironmentAccess {
  return {
    shellSnapshot: vi.fn(async () => shellSnapshot([])),
    searchThreads: vi.fn(async () => searchResult([])),
    threadSnapshot: vi.fn(async () => detailSnapshot(projection({ id: threadA }))),
    serverConfig: vi.fn(async () => ({ providers: [] }) as unknown as ServerConfig),
    subscribeThread: vi.fn(async (): Promise<OrchestrationV2ThreadStreamItem> => ({
      kind: "synchronized",
    })),
    ...overrides,
  };
}

function hostMock(input: {
  entries?: VoiceEnvironmentCatalogEntry[];
  access?: VoiceEnvironmentAccess | null;
}): VoiceToolHost & {
  catalogEnvironments: ReturnType<typeof vi.fn>;
  openEnvironment: ReturnType<typeof vi.fn>;
} {
  const access = input.access === undefined ? null : input.access;
  return {
    catalogEnvironments: vi.fn(() => input.entries ?? []),
    openEnvironment: vi.fn(() => access),
  } as unknown as VoiceToolHost & {
    catalogEnvironments: ReturnType<typeof vi.fn>;
    openEnvironment: ReturnType<typeof vi.fn>;
  };
}

// ---------------------------------------------------------------------------
// splitSearchTerms
// ---------------------------------------------------------------------------

describe("splitSearchTerms", () => {
  it("splits a spoken phrase into at most four distinctive terms, longest first", () => {
    expect(splitSearchTerms("Planning the Macroscope and CodeRabbit trials")).toEqual([
      "macroscope",
      "coderabbit",
      "planning",
      "trials",
    ]);
  });

  it("deduplicates case-insensitively via normalized text and drops short tokens", () => {
    expect(splitSearchTerms("Oracle Oracle a I deployment")).toEqual(["deployment", "oracle"]);
  });

  it("falls back to the whole query when every token is shorter than two characters", () => {
    expect(splitSearchTerms("a b c d e f g h")).toEqual(["a b c d e f g h"]);
  });

  it("caps the term count at the requested maximum", () => {
    expect(splitSearchTerms("alpha beta gamma delta epsilon zeta", 2)).toEqual([
      "epsilon",
      "alpha",
    ]);
  });
});

// ---------------------------------------------------------------------------
// classifyEnvironmentFailure
// ---------------------------------------------------------------------------

describe("classifyEnvironmentFailure", () => {
  it("maps server contract error tags to frozen codes", () => {
    expect(
      classifyEnvironmentFailure({ _tag: "EnvironmentScopeRequiredError", message: "needs scope" }),
    ).toEqual({ code: "insufficient_scope", message: "needs scope" });
    expect(
      classifyEnvironmentFailure({ _tag: "EnvironmentAuthInvalidError", message: "revoked" }),
    ).toEqual({ code: "auth_invalid", message: "revoked" });
    expect(
      classifyEnvironmentFailure({ _tag: "EnvironmentResourceNotFoundError", message: "gone" }),
    ).toEqual({ code: "thread_not_found", message: "gone" });
  });

  it("maps boundary errors and unknown causes without inventing codes", () => {
    expect(
      classifyEnvironmentFailure(new VoiceEnvironmentAccessError("thread_not_found", "missing")),
    ).toEqual({ code: "thread_not_found", message: "missing" });
    expect(classifyEnvironmentFailure(new Error("socket closed"))).toEqual({
      code: "environment_unreachable",
      message: "socket closed",
    });
  });
});

// ---------------------------------------------------------------------------
// evaluateModelAvailability
// ---------------------------------------------------------------------------

describe("evaluateModelAvailability", () => {
  const providers: ServerProvider[] = [
    serverProvider({
      instanceId: "ok",
      models: [{ slug: "model-a", name: "Model A", isCustom: false, capabilities: null }],
    }),
    serverProvider({ instanceId: "disabled", enabled: false }),
    serverProvider({
      instanceId: "unavailable",
      availability: "unavailable",
      unavailableReason: "driver missing",
    }),
  ];

  it("accepts a model present under an enabled, available provider", () => {
    expect(evaluateModelAvailability(providers, "ok", "model-a")).toEqual({ available: true });
  });

  it("rejects a disabled provider", () => {
    const result = evaluateModelAvailability(providers, "disabled", "model-a");
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("disabled");
  });

  it("surfaces unavailableReason for an unavailable provider", () => {
    expect(evaluateModelAvailability(providers, "unavailable", "model-a")).toEqual({
      available: false,
      reason: "driver missing",
    });
  });

  it("rejects a slug missing from the provider's current catalog", () => {
    const result = evaluateModelAvailability(providers, "ok", "not-offered");
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("not-offered");
  });

  it("rejects an unknown provider instance", () => {
    expect(evaluateModelAvailability(providers, "ghost", "model-a").available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// projectThreadTurns
// ---------------------------------------------------------------------------

describe("projectThreadTurns", () => {
  it("groups messages into user-anchored turns keyed by run, with final assistant text", () => {
    const turns = projectThreadTurns([
      message({ role: "user", text: "plan the trials", runId: runA }),
      message({ role: "assistant", text: "draft one", runId: runA }),
      message({ role: "assistant", text: "final draft", runId: runA }),
      message({ role: "system", text: "ignored" }),
      message({ role: "user", text: "go" }),
    ]);
    expect(turns).toEqual([
      {
        runId: runA,
        createdAt: "2026-09-02T10:00:00.000Z",
        userText: "plan the trials",
        assistantText: "final draft",
      },
      {
        createdAt: "2026-09-02T10:00:00.000Z",
        userText: "go",
        assistantText: null,
      },
    ]);
  });

  it("truncates turn text at 2000 characters", () => {
    const long = "x".repeat(2500);
    const turns = projectThreadTurns([
      message({ role: "user", text: long }),
      message({ role: "assistant", text: long }),
    ]);
    expect(turns[0]?.userText).toHaveLength(2000);
    expect(turns[0]?.assistantText).toHaveLength(2000);
  });
});

// ---------------------------------------------------------------------------
// discoverEnvironments / discoverProjects
// ---------------------------------------------------------------------------

describe("discoverEnvironments", () => {
  it("projects the client catalog without any network call", async () => {
    const host = hostMock({
      entries: [
        catalogEntry({ environmentId: envA, isPrimary: true, voiceLiveCapable: true }),
        catalogEntry({
          environmentId: envB,
          connectionState: "disconnected",
          scopes: ["orchestration:read"],
        }),
      ],
    });
    const executor = createVoiceToolExecutor(host);
    const result = await executor.discoverEnvironments();
    expect(result.environments).toEqual([
      {
        environmentId: envA,
        label: envA,
        connectionState: "connected",
        isPrimary: true,
        voiceLiveCapable: true,
        scopes: ["orchestration:read", "orchestration:operate"],
      },
      {
        environmentId: envB,
        label: envB,
        connectionState: "disconnected",
        isPrimary: false,
        voiceLiveCapable: false,
        scopes: ["orchestration:read"],
      },
    ]);
    expect(host.openEnvironment).not.toHaveBeenCalled();
  });
});

describe("discoverProjects", () => {
  it("refuses a fabricated environment from the catalog without a network call", async () => {
    const access = accessMock();
    const host = hostMock({ entries: [catalogEntry({ environmentId: envA })], access });
    const executor = createVoiceToolExecutor(host);
    const result = await executor.discoverProjects({
      environmentId: EnvironmentId.make("ghost"),
    });
    expect(result.environment.status).toBe("error");
    expect(result.environment.error?.code).toBe("environment_not_in_catalog");
    expect(result.projects).toEqual([]);
    expect(host.openEnvironment).not.toHaveBeenCalled();
    expect(access.shellSnapshot).not.toHaveBeenCalled();
  });

  it("reports a disconnected environment as disconnected, never as empty", async () => {
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access: null }),
    );
    const result = await executor.discoverProjects({ environmentId: envA });
    expect(result.environment.status).toBe("disconnected");
    expect(result.environment.error?.code).toBe("environment_unreachable");
    expect(result.projects).toEqual([]);
  });

  it("maps shell projects without fabricating overrides", async () => {
    const access = accessMock({
      shellSnapshot: vi.fn(async () =>
        shellSnapshot(
          [],
          [
            projectShell({ id: projectA, defaultThreadEnvMode: "worktree" }),
            projectShell({ id: projectB, defaultModelSelection: modelSelection }),
          ],
        ),
      ),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.discoverProjects({ environmentId: envA });
    expect(result.environment.status).toBe("ok");
    expect(result.projects).toEqual([
      {
        projectId: projectA,
        title: "Oracle",
        workspaceRoot: "/tmp/oracle",
        defaultModelSelection: null,
        defaultThreadEnvMode: "worktree",
      },
      {
        projectId: projectB,
        title: "Oracle",
        workspaceRoot: "/tmp/oracle",
        defaultModelSelection: modelSelection,
        defaultThreadEnvMode: "local",
      },
    ]);
  });

  it("propagates scope denial from the target environment", async () => {
    const access = accessMock({
      shellSnapshot: vi.fn(async () => {
        throw { _tag: "EnvironmentScopeRequiredError", message: "needs orchestration:read" };
      }),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.discoverProjects({ environmentId: envA });
    expect(result.environment.status).toBe("error");
    expect(result.environment.error?.code).toBe("insufficient_scope");
  });
});

// ---------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------

describe("listModels", () => {
  it("returns only enabled, available providers as options", async () => {
    const config = {
      providers: [
        serverProvider({
          instanceId: "ok",
          models: [
            {
              slug: "model-a",
              name: "Model A",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
        }),
        serverProvider({ instanceId: "disabled", enabled: false }),
        serverProvider({ instanceId: "unavailable", availability: "unavailable" as const }),
      ],
    } as unknown as ServerConfig;
    const access = accessMock({ serverConfig: vi.fn(async () => config) });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.listModels({ environmentId: envA });
    expect(result.environment.status).toBe("ok");
    expect(result.providers).toEqual([
      {
        instanceId: "ok",
        driver: "claude",
        enabled: true,
        availability: "available",
        models: [{ slug: "model-a", name: "Model A", isCustom: false, isDefault: true }],
      },
    ]);
  });

  it("reports auth failure from the config delivery", async () => {
    const access = accessMock({
      serverConfig: vi.fn(async () => {
        throw { _tag: "EnvironmentAuthInvalidError", message: "session revoked" };
      }),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.listModels({ environmentId: envA });
    expect(result.providers).toEqual([]);
    expect(result.environment.error?.code).toBe("auth_invalid");
  });
});

// ---------------------------------------------------------------------------
// searchThreads
// ---------------------------------------------------------------------------

describe("searchThreads", () => {
  it("rejects out-of-bounds queries without touching any environment", async () => {
    const access = accessMock();
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    await expect(executor.searchThreads({ query: "x" })).rejects.toMatchObject({
      error: { code: "query_invalid" },
    });
    await expect(executor.searchThreads({ query: "y".repeat(201) })).rejects.toBeInstanceOf(
      VoiceToolFailureError,
    );
    expect(access.searchThreads).not.toHaveBeenCalled();
  });

  it("unions title and per-term message matches, deduped by thread, ranked by coverage", async () => {
    const access = accessMock({
      shellSnapshot: vi.fn(async () =>
        shellSnapshot([
          threadShell({
            id: threadA,
            title: "Planning the Macroscope and CodeRabbit trials",
            updatedAt: DateTime.makeUnsafe("2026-09-05T00:00:00.000Z"),
          }),
          threadShell({
            id: threadB,
            title: "Unrelated thread",
            updatedAt: DateTime.makeUnsafe("2026-09-06T00:00:00.000Z"),
          }),
        ]),
      ),
      searchThreads: vi.fn(async (input: { query: string }) =>
        searchResult(
          input.query === "macroscope"
            ? [searchMatch({ threadId: threadA, snippet: "macroscope kickoff" })]
            : input.query === "coderabbit"
              ? [
                  searchMatch({ threadId: threadA, snippet: "coderabbit trial notes" }),
                  searchMatch({ threadId: threadB, snippet: "coderabbit mention" }),
                ]
              : [],
        ),
      ),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.searchThreads({ query: "Macroscope and CodeRabbit trials" });

    expect(result.perEnvironment).toHaveLength(1);
    const slice = result.perEnvironment[0];
    expect(slice?.environment.status).toBe("ok");
    const matches: ReadonlyArray<VoiceThreadSearchMatch> = slice?.matches ?? [];
    expect(matches).toHaveLength(2);

    // threadA matched every term plus the title: ranked first, deduped to one
    // entry carrying both the snippet and the title-match flag.
    expect(matches[0]?.threadId).toBe(threadA);
    expect(matches[0]?.source).toBe("message");
    expect(matches[0]?.snippet).toBe("macroscope kickoff");
    expect(matches[0]?.threadTitle).toBe("Planning the Macroscope and CodeRabbit trials");
    expect(matches[0]?.termCoverage).toBe(1);
    expect(matches[0]?.titleMatch).toBe(true);

    // One bounded server search per distinctive term, never the whole phrase,
    // and never a server score or matchedTerms field.
    expect(access.searchThreads).toHaveBeenCalledTimes(4);
    const queriedTerms = (access.searchThreads as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { query: string }).query,
    );
    expect(queriedTerms).toEqual(["macroscope", "coderabbit", "trials", "and"]);

    // threadB matched one term by message only.
    expect(matches[1]?.threadId).toBe(threadB);
    expect(matches[1]?.termCoverage).toBe(0.25);
    expect(matches[1]?.titleMatch).toBeUndefined();
  });

  it("reports a disconnected environment as could-not-search, never as no matches", async () => {
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA, label: "Oracle" })], access: null }),
    );
    const result = await executor.searchThreads({ query: "anything at all" });
    expect(result.perEnvironment[0]?.environment.status).toBe("disconnected");
    expect(result.perEnvironment[0]?.environment.error?.message).toContain("not connected");
    expect(result.perEnvironment[0]?.environment.error?.code).toBe("environment_unreachable");
    expect(result.perEnvironment[0]?.matches).toEqual([]);
  });

  it("keeps partial results visible when one term search fails", async () => {
    const access = accessMock({
      searchThreads: vi.fn(async (input: { query: string }) => {
        if (input.query === "coderabbit") {
          throw { _tag: "EnvironmentScopeRequiredError", message: "denied" };
        }
        return searchResult([searchMatch({ threadId: threadA, snippet: "hit" })]);
      }),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.searchThreads({ query: "macroscope coderabbit trials" });
    expect(result.perEnvironment[0]?.environment.status).toBe("partial");
    expect(result.perEnvironment[0]?.environment.error?.code).toBe("insufficient_scope");
    expect(result.perEnvironment[0]?.matches).toHaveLength(1);
  });

  it("reports a fully failed environment with an error outcome", async () => {
    const access = accessMock({
      shellSnapshot: vi.fn(async () => {
        throw new Error("transport died");
      }),
      searchThreads: vi.fn(async () => {
        throw new Error("transport died");
      }),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.searchThreads({ query: "anything at all" });
    expect(result.perEnvironment[0]?.environment.status).toBe("error");
    expect(result.perEnvironment[0]?.matches).toEqual([]);
  });

  it("excludes archived threads by default and includes archived titles on request", async () => {
    const access = accessMock({
      shellSnapshot: vi.fn(async () =>
        shellSnapshot(
          [threadShell({ id: threadA, title: "active macroscope thread" })],
          [],
          [
            threadShell({
              id: threadArchived,
              title: "archived macroscope thread",
            }),
          ],
        ),
      ),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );

    const byDefault = await executor.searchThreads({ query: "macroscope" });
    expect(byDefault.perEnvironment[0]?.matches.map((m) => m.threadId)).toEqual([threadA]);

    const withArchived = await executor.searchThreads({
      query: "macroscope",
      includeArchived: true,
    });
    const archivedMatch = withArchived.perEnvironment[0]?.matches.find(
      (m) => m.threadId === threadArchived,
    );
    expect(archivedMatch).toBeDefined();
    expect(archivedMatch?.archived).toBe(true);
    expect(archivedMatch?.source).toBe("title");
    expect(archivedMatch?.snippet).toBeUndefined();
  });

  it("clamps the per-environment server limit to the frozen bound", async () => {
    const access = accessMock();
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    await executor.searchThreads({ query: "some phrase here", limitPerEnvironment: 500 });
    expect(access.searchThreads).toHaveBeenCalledWith({ query: "some", limit: 50 });
  });

  it("reports fabricated environment ids per environment without network calls", async () => {
    const access = accessMock();
    const host = hostMock({ entries: [catalogEntry({ environmentId: envA })], access });
    const executor = createVoiceToolExecutor(host);
    const result = await executor.searchThreads({
      query: "valid query",
      environmentIds: [envA, EnvironmentId.make("ghost")],
    });
    expect(result.perEnvironment[0]?.environment.status).toBe("ok");
    expect(result.perEnvironment[1]?.environment.error?.code).toBe("environment_not_in_catalog");
    // Only the catalog environment was opened; the fabricated id never reached
    // the prepared-connection boundary.
    expect(host.openEnvironment).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// readThread / readProject
// ---------------------------------------------------------------------------

describe("readThread", () => {
  it("projects a bounded history read with run evidence", async () => {
    const access = accessMock({
      threadSnapshot: vi.fn(async () =>
        detailSnapshot(
          projection({
            id: threadA,
            title: "Trials planning",
            runs: [run({ status: "running" })],
            messages: [
              message({ role: "user", text: "plan it", runId: runA }),
              message({ role: "assistant", text: "done", runId: runA }),
            ],
          }),
        ),
      ),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.readThread({ environmentId: envA, threadId: threadA });
    expect(result.environment.status).toBe("ok");
    expect(result.thread?.runStatus).toBe("running");
    expect(result.thread?.turns).toEqual([
      {
        runId: runA,
        createdAt: "2026-09-02T10:00:00.000Z",
        userText: "plan it",
        assistantText: "done",
      },
    ]);
    expect(access.threadSnapshot).toHaveBeenCalledWith(threadA);
  });

  it("honors the requested turn window", async () => {
    const access = accessMock({
      threadSnapshot: vi.fn(async () =>
        detailSnapshot(
          projection({
            id: threadA,
            messages: [
              message({ id: MessageId.make("msg-1"), role: "user", text: "one", runId: runA }),
              message({
                id: MessageId.make("msg-2"),
                role: "user",
                text: "two",
                runId: RunId.make("run-b"),
              }),
              message({
                id: MessageId.make("msg-3"),
                role: "user",
                text: "three",
                runId: RunId.make("run-c"),
              }),
            ],
          }),
        ),
      ),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.readThread({
      environmentId: envA,
      threadId: threadA,
      turnLimit: 2,
    });
    expect(result.thread?.turns.map((turn) => turn.userText)).toEqual(["two", "three"]);
    expect(result.thread?.truncated).toBe(true);
  });

  it("propagates scope denial and revocation from the target", async () => {
    const scopeAccess = accessMock({
      threadSnapshot: vi.fn(async () => {
        throw { _tag: "EnvironmentScopeRequiredError", message: "read scope required" };
      }),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access: scopeAccess }),
    );
    const denied = await executor.readThread({ environmentId: envA, threadId: threadA });
    expect(denied.environment.error?.code).toBe("insufficient_scope");

    const revokedAccess = accessMock({
      threadSnapshot: vi.fn(async () => {
        throw { _tag: "EnvironmentAuthInvalidError", message: "invalid credential" };
      }),
    });
    const revokedExecutor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access: revokedAccess }),
    );
    const revoked = await revokedExecutor.readThread({ environmentId: envA, threadId: threadA });
    expect(revoked.environment.error?.code).toBe("auth_invalid");
  });

  it("maps a 404 thread read to thread_not_found", async () => {
    const access = accessMock({
      threadSnapshot: vi.fn(async () => {
        throw { _tag: "EnvironmentResourceNotFoundError", message: "not found" };
      }),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.readThread({ environmentId: envA, threadId: threadA });
    expect(result.environment.error?.code).toBe("thread_not_found");
    expect(result.thread).toBeUndefined();
  });
});

describe("readProject", () => {
  it("returns the project and its recent non-archived threads, newest first", async () => {
    const access = accessMock({
      shellSnapshot: vi.fn(async () =>
        shellSnapshot(
          [
            threadShell({
              id: threadB,
              title: "newer",
              updatedAt: DateTime.makeUnsafe("2026-09-07T00:00:00.000Z"),
            }),
            threadShell({
              id: threadA,
              title: "older",
              updatedAt: DateTime.makeUnsafe("2026-09-03T00:00:00.000Z"),
            }),
            threadShell({
              id: threadArchived,
              title: "archived",
              archivedAt: DateTime.makeUnsafe("2026-09-04T00:00:00.000Z"),
            }),
            threadShell({ id: threadB, projectId: projectB, title: "other project" }),
          ],
          [projectShell({ id: projectA })],
        ),
      ),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.readProject({ environmentId: envA, projectId: projectA });
    expect(result.environment.status).toBe("ok");
    expect(result.project?.projectId).toBe(projectA);
    expect(result.recentThreads.map((t) => t.threadId)).toEqual([threadB, threadA]);
    expect(result.recentThreads[0]?.runStatus).toBe("idle");
  });

  it("refuses an unknown project id instead of fabricating results", async () => {
    const access = accessMock({
      shellSnapshot: vi.fn(async () => shellSnapshot([], [projectShell({ id: projectA })])),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.readProject({ environmentId: envA, projectId: projectB });
    expect(result.environment.status).toBe("error");
    expect(result.environment.error?.code).toBe("project_not_found");
    expect(result.project).toBeUndefined();
    expect(result.recentThreads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// openThread / startThread / observeThread
// ---------------------------------------------------------------------------

describe("openThread", () => {
  it("validates existence in the shell and reports the destination without navigating", async () => {
    const access = accessMock({
      shellSnapshot: vi.fn(async () =>
        shellSnapshot([threadShell({ id: threadA, title: "Thread" })]),
      ),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.openThread({ environmentId: envA, threadId: threadA });
    expect(result.environment.status).toBe("ok");
    expect(result.acknowledged).toBe(false);
    expect(result.destination).toEqual({ environmentId: envA, threadId: threadA });
  });

  it("falls back to a detail read when the shell misses", async () => {
    const access = accessMock({
      threadSnapshot: vi.fn(async () => detailSnapshot(projection({ id: threadA }))),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.openThread({ environmentId: envA, threadId: threadA });
    expect(access.threadSnapshot).toHaveBeenCalledWith(threadA);
    expect(result.destination).toEqual({ environmentId: envA, threadId: threadA });
  });

  it("reports thread_not_found when neither shell nor detail read finds the thread", async () => {
    const access = accessMock({
      threadSnapshot: vi.fn(async () => {
        throw { _tag: "EnvironmentResourceNotFoundError", message: "not found" };
      }),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.openThread({ environmentId: envA, threadId: threadA });
    expect(result.environment.error?.code).toBe("thread_not_found");
    expect(result.acknowledged).toBe(false);
    expect(result.destination).toBeUndefined();
  });
});

// T5 replaced the startThread stub with the real creation path; its focused
// tests live in start.test.ts.

describe("observeThread", () => {
  it("derives run, run identity, and running state from the subscription snapshot", async () => {
    const access = accessMock({
      subscribeThread: vi.fn(async (): Promise<OrchestrationV2ThreadStreamItem> => ({
        kind: "snapshot",
        snapshotSequence: 11,
        projection: projection({
          id: threadA,
          runs: [run({ status: "running" })],
          messages: [message({ role: "user", text: "plan it", runId: runA })],
        }),
      })),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.observeThread({ environmentId: envA, threadId: threadA });
    expect(result.environment.status).toBe("ok");
    expect(result.threadId).toBe(threadA);
    expect(result.sequence).toBe(11);
    expect(result.run).toEqual({ status: "running", lastError: null });
    expect(result.runId).toBe(runA);
    expect(result.running).toBe(true);
    expect(access.subscribeThread).toHaveBeenCalledWith({ threadId: threadA });
  });

  it("resumes from afterSequence via replay events and enriches run state", async () => {
    const access = accessMock({
      subscribeThread: vi.fn(async (): Promise<OrchestrationV2ThreadStreamItem> => ({
        kind: "event",
        sequence: 41,
        event: {
          sequence: 41,
          eventId: "event-1",
          aggregateKind: "thread",
          aggregateId: threadA,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "message.updated",
          payload: {},
        } as never,
      })),
      threadSnapshot: vi.fn(async () =>
        detailSnapshot(
          projection({
            id: threadA,
            runs: [run({ status: "completed", completedAt: now })],
          }),
        ),
      ),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    const result = await executor.observeThread({
      environmentId: envA,
      threadId: threadA,
      afterSequence: 40,
    });
    expect(access.subscribeThread).toHaveBeenCalledWith({
      threadId: threadA,
      afterSequence: 40,
      requestCompletionMarker: true,
    });
    expect(result.sequence).toBe(41);
    expect(result.run.status).toBe("completed");
    expect(result.running).toBe(false);
  });

  it("fails with a frozen error when the thread cannot be observed", async () => {
    const access = accessMock({
      subscribeThread: vi.fn(async () => {
        throw { _tag: "EnvironmentResourceNotFoundError", message: "not found" };
      }),
    });
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    await expect(
      executor.observeThread({ environmentId: envA, threadId: threadA }),
    ).rejects.toMatchObject({ error: { code: "thread_not_found" } });
  });

  it("refuses a fabricated environment without a network call", async () => {
    const access = accessMock();
    const executor = createVoiceToolExecutor(
      hostMock({ entries: [catalogEntry({ environmentId: envA })], access }),
    );
    await expect(
      executor.observeThread({ environmentId: EnvironmentId.make("ghost"), threadId: threadA }),
    ).rejects.toMatchObject({ error: { code: "environment_not_in_catalog" } });
    expect(access.subscribeThread).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listControls / clickControl (client-local UI control seam)
// ---------------------------------------------------------------------------

describe("listControls and clickControl", () => {
  it("refuse explicitly when the host exposes no UI control source", async () => {
    const executor = createVoiceToolExecutor(hostMock({}));
    await expect(executor.listControls({})).resolves.toEqual({
      controls: [],
      error: expect.objectContaining({ code: "invalid_request" }),
    });
    await expect(executor.clickControl({ controlId: "button#1:Run" })).resolves.toMatchObject({
      controlId: "button#1:Run",
      state: "unsupported",
    });
  });

  it("delegate to the host's client-local UI control seam unchanged", async () => {
    const listControls = vi.fn(async () => ({ controls: [] }));
    const clickControl = vi.fn(async () => ({
      controlId: "button#1:Run",
      state: "activated" as const,
    }));
    const host = {
      ...hostMock({}),
      uiControls: { listControls, clickControl },
    } as unknown as VoiceToolHost;
    const executor = createVoiceToolExecutor(host);
    await executor.listControls({ query: "run" });
    expect(listControls).toHaveBeenCalledWith({ query: "run" });
    await executor.clickControl({ controlId: "button#1:Run" });
    expect(clickControl).toHaveBeenCalledWith({ controlId: "button#1:Run" });
  });
});
