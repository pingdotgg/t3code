import { expect, it } from "@effect/vitest";
import {
  EventId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
  type ProviderSessionDirectoryShape,
} from "../../../provider/Services/ProviderSessionDirectory.ts";
import { readThread } from "./handlers.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const t3ThreadId = ThreadId.make("t3-thread-1");
const providerThreadId = "019c-native-codex-thread";
const projectId = ProjectId.make("project-1");

const project: OrchestrationProjectShell = {
  id: projectId,
  title: "T3 Code",
  workspaceRoot: "/workspace/t3code",
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const thread: OrchestrationThread = {
  id: t3ThreadId,
  projectId,
  title: "Cross-thread implementation",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  deletedAt: null,
  messages: [
    {
      id: MessageId.make("message-1"),
      role: "user",
      text: "first",
      turnId: null,
      streaming: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: MessageId.make("message-2"),
      role: "assistant",
      text: "second",
      turnId: null,
      streaming: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  proposedPlans: [],
  activities: [
    {
      id: EventId.make("activity-1"),
      tone: "info",
      kind: "status",
      summary: "Working",
      payload: {},
      turnId: null,
      createdAt: NOW,
    },
  ],
  checkpoints: [],
  session: {
    threadId: t3ThreadId,
    status: "ready",
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  },
};

const binding: ProviderRuntimeBindingWithMetadata = {
  threadId: t3ThreadId,
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  resumeCursor: { threadId: providerThreadId },
  lastSeenAt: NOW,
};

const invocation = McpInvocationContext.McpInvocationContext.of({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("requesting-thread"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview", "thread-read"] as const),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

const unused = () => Effect.die("unused");

function makeSnapshotQuery(): ProjectionSnapshotQueryShape {
  return {
    getCommandReadModel: unused,
    getSnapshot: unused,
    getShellSnapshot: unused,
    getArchivedShellSnapshot: unused,
    getSnapshotSequence: unused,
    getCounts: unused,
    getActiveProjectByWorkspaceRoot: unused,
    getFirstActiveThreadIdByProjectId: unused,
    getThreadCheckpointContext: unused,
    getFullThreadDiffContext: unused,
    getThreadShellById: unused,
    getThreadDetailSnapshot: unused,
    getProjectShellById: (id) =>
      Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    getThreadDetailById: (id) =>
      Effect.succeed(id === t3ThreadId ? Option.some(thread) : Option.none()),
  };
}

const sessionDirectory: ProviderSessionDirectoryShape = {
  upsert: unused,
  getProvider: unused,
  getBinding: unused,
  listThreadIds: unused,
  listBindings: () => Effect.succeed([binding]),
};

function runRead(input: Parameters<typeof readThread>[0]) {
  return readThread(input).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(ProjectionSnapshotQuery, makeSnapshotQuery()),
    Effect.provideService(ProviderSessionDirectory, sessionDirectory),
  );
}

it.effect("reads a thread by its T3 ID without modifying it", () =>
  Effect.gen(function* () {
    const before = structuredClone(thread);
    const result = yield* runRead({ threadId: t3ThreadId });

    expect(result.threadId).toBe(t3ThreadId);
    expect(result.providerThreadId).toBe(providerThreadId);
    expect(result.messages.map(({ text }) => text)).toEqual(["first", "second"]);
    expect(thread).toEqual(before);
  }),
);

it.effect("resolves a copied Codex thread ID and bounds the returned history", () =>
  Effect.gen(function* () {
    const result = yield* runRead({
      threadId: providerThreadId,
      messageLimit: 1,
      activityLimit: 1,
    });

    expect(result.threadId).toBe(t3ThreadId);
    expect(result.messages.map(({ text }) => text)).toEqual(["second"]);
    expect(result.totals.messages).toBe(2);
    expect(result.truncated.messages).toBe(true);
  }),
);

it.effect("does not disclose a thread when cross-thread capability is absent", () =>
  Effect.gen(function* () {
    const restrictedInvocation = {
      ...invocation,
      capabilities: new Set(["preview"] as const),
    };
    const error = yield* readThread({ threadId: t3ThreadId }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, restrictedInvocation),
      Effect.provideService(ProjectionSnapshotQuery, makeSnapshotQuery()),
      Effect.provideService(ProviderSessionDirectory, sessionDirectory),
      Effect.flip,
    );

    expect(error._tag).toBe("ThreadReadUnavailableError");
  }),
);
