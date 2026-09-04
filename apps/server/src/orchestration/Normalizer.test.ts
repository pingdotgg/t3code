import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadTurnState,
} from "./Services/ProjectionSnapshotQuery.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";
const sourceThreadId = ThreadId.make("thread-source");
const sourceTurnId = TurnId.make("turn-source");
const sourceMessageId = MessageId.make("message-source");
const liveSourceInstanceId = ProviderInstanceId.make("codex-live");
const liveSourceSession: NonNullable<OrchestrationThreadShell["session"]> = {
  threadId: sourceThreadId,
  status: "ready",
  providerName: "codex",
  providerInstanceId: liveSourceInstanceId,
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-09-03T12:00:00.000Z",
};
const latestSourceTurnId = TurnId.make("turn-source-latest");
const sourceProviderInstanceId = ProviderInstanceId.make("claudeAgent");

const normalizerBaseLayer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-fork-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const makeLatestTurn = (turnId: TurnId): NonNullable<OrchestrationThreadShell["latestTurn"]> => ({
  turnId,
  state: "completed",
  requestedAt: "2026-09-03T11:59:00.000Z",
  startedAt: "2026-09-03T11:59:01.000Z",
  completedAt: "2026-09-03T12:00:00.000Z",
  assistantMessageId: sourceMessageId,
});

const makeSourceThread = (
  latestTurn: OrchestrationThreadShell["latestTurn"],
  session: OrchestrationThreadShell["session"] = null,
): OrchestrationThreadShell => ({
  id: sourceThreadId,
  projectId: ProjectId.make("project-source"),
  title: "Source thread",
  modelSelection: {
    instanceId: sourceProviderInstanceId,
    model: "claude-opus-4-6",
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn,
  createdAt: "2026-09-03T11:00:00.000Z",
  updatedAt: "2026-09-03T12:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const normalizeFork = (
  sourceTurn: Option.Option<ProjectionThreadTurnState>,
  options?: {
    readonly sessionFork?: "any-turn" | "latest-turn" | "unsupported";
    /** Capability of the instance the source's live session is bound to, when it differs. */
    readonly liveSessionSessionFork?: "any-turn" | "latest-turn" | "unsupported";
    readonly latestTurn?: OrchestrationThreadShell["latestTurn"];
    readonly sourceArchived?: boolean;
  },
) =>
  normalizeDispatchCommand({
    type: "thread.fork",
    commandId: CommandId.make("command-fork"),
    threadId: ThreadId.make("thread-fork"),
    sourceThreadId,
    sourceTurnId,
    sourceMessageId,
    sideChat: true,
    createdAt: "2026-09-03T12:00:00.000Z",
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        normalizerBaseLayer,
        Layer.mock(ProjectionSnapshotQuery, {
          getThreadTurnState: () => Effect.succeed(sourceTurn),
          getThreadShellById: () =>
            Effect.succeed(
              options?.sourceArchived === true
                ? Option.none()
                : Option.some(
                    makeSourceThread(
                      options?.latestTurn ?? makeLatestTurn(sourceTurnId),
                      options?.liveSessionSessionFork === undefined ? null : liveSourceSession,
                    ),
                  ),
            ),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads:
                options?.sourceArchived === true
                  ? [makeSourceThread(options.latestTurn ?? makeLatestTurn(sourceTurnId))]
                  : [],
              updatedAt: "2026-09-03T12:00:00.000Z",
            }),
        }),
        Layer.mock(ProviderService, {
          getCapabilities: (instanceId) =>
            Effect.succeed({
              sessionModelSwitch: "in-session",
              sessionFork:
                instanceId === liveSourceInstanceId
                  ? (options?.liveSessionSessionFork ?? options?.sessionFork ?? "any-turn")
                  : (options?.sessionFork ?? "any-turn"),
            }),
        }),
      ),
    ),
  );

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

describe("normalizeDispatchCommand thread.fork", () => {
  effectIt.effect("rejects a nonexistent source turn", () =>
    Effect.gen(function* () {
      const error = yield* normalizeFork(Option.none()).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("does not exist");
    }),
  );

  effectIt.effect("rejects an incomplete source turn", () =>
    Effect.gen(function* () {
      const error = yield* normalizeFork(
        Option.some({ state: "running", assistantMessageId: null }),
      ).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("not a completed turn");
    }),
  );

  effectIt.effect("rejects a source message that does not match the source turn", () =>
    Effect.gen(function* () {
      const error = yield* normalizeFork(
        Option.some({
          state: "completed",
          assistantMessageId: MessageId.make("message-other"),
        }),
      ).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("is not the assistant message");
    }),
  );

  effectIt.effect("rejects a historical source turn for a latest-turn provider", () =>
    Effect.gen(function* () {
      const error = yield* normalizeFork(
        Option.some({ state: "completed", assistantMessageId: sourceMessageId }),
        {
          sessionFork: "latest-turn",
          latestTurn: makeLatestTurn(latestSourceTurnId),
        },
      ).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("not the latest completed turn");
    }),
  );

  effectIt.effect("reads the fork capability from the source's live session instance", () =>
    Effect.gen(function* () {
      // The stored selection points at a latest-turn instance, but the live
      // session moved to an any-turn one; the live instance decides.
      const error = yield* normalizeFork(
        Option.some({ state: "completed", assistantMessageId: sourceMessageId }),
        {
          sessionFork: "latest-turn",
          latestTurn: makeLatestTurn(latestSourceTurnId),
          liveSessionSessionFork: "any-turn",
        },
      ).pipe(Effect.flip, Effect.option);
      expect(Option.isNone(error)).toBe(true);
    }),
  );

  effectIt.effect("allows a historical source turn for an any-turn provider", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeFork(
        Option.some({ state: "completed", assistantMessageId: sourceMessageId }),
        {
          sessionFork: "any-turn",
          latestTurn: makeLatestTurn(latestSourceTurnId),
        },
      );

      expect(normalized.type).toBe("thread.fork");
    }),
  );

  effectIt.effect("rejects a historical archived source for a latest-turn provider", () =>
    Effect.gen(function* () {
      const error = yield* normalizeFork(
        Option.some({ state: "completed", assistantMessageId: sourceMessageId }),
        {
          sessionFork: "latest-turn",
          latestTurn: makeLatestTurn(latestSourceTurnId),
          sourceArchived: true,
        },
      ).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("not the latest completed turn");
    }),
  );
});
