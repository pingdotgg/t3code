import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ServerConfigShape, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "../../git/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { ProviderCommandReactorLive } from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asSessionId = (value: string): ProviderSessionId => ProviderSessionId.makeUnsafe(value);
const asProviderTurnId = (value: string): ProviderTurnId => ProviderTurnId.makeUnsafe(value);
const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

function makeTestServerConfig(stateDir: string): ServerConfigShape {
  return {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: process.cwd(),
    keybindingsConfigPath: "",
    stateDir,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderCommandReactor,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function createHarness(input?: { readonly stateDir?: string }) {
    const now = new Date().toISOString();
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const startSession = vi.fn((_: unknown, __: unknown) => {
      const sessionIndex = nextSessionIndex++;
      return Effect.succeed({
        sessionId: asSessionId(`sess-${sessionIndex}`),
        provider: "codex" as const,
        status: "ready" as const,
        threadId: ProviderThreadId.makeUnsafe(`provider-thread-${sessionIndex}`),
        createdAt: now,
        updatedAt: now,
      });
    });
    const sendTurn = vi.fn((_: unknown) =>
      Effect.succeed({
        threadId: ProviderThreadId.makeUnsafe("provider-thread-1"),
        turnId: asProviderTurnId("provider-turn-1"),
      }),
    );
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const respondToRequest = vi.fn((_: unknown) => Effect.void);
    const stopSession = vi.fn((_: unknown) => Effect.void);
    const renameBranch = vi.fn((_: unknown) =>
      Effect.succeed({
        branch: "t3code/generated-name",
      }),
    );
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>(() =>
      Effect.succeed({
        branch: "generated-name",
      }),
    );

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed([]),
      rollbackConversation: () => unsupported(),
      stopAll: () => Effect.void,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const liveLayer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(Layer.succeed(GitCore, { renameBranch } as unknown as GitCoreShape)),
      Layer.provideMerge(
        Layer.succeed(TextGeneration, { generateBranchName } as unknown as TextGenerationShape),
      ),
    );
    const layer =
      input?.stateDir !== undefined
        ? liveLayer.pipe(
            Layer.provideMerge(Layer.succeed(ServerConfig, makeTestServerConfig(input.stateDir))),
          )
        : liveLayer;
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));
    await Effect.runPromise(Effect.sleep("10 millis"));

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModel: "gpt-5-codex",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        model: "gpt-5-codex",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return {
      engine,
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      stopSession,
      renameBranch,
      generateBranchName,
    };
  }

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.makeUnsafe("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      model: "gpt-5-codex",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.providerSessionId).toBe("sess-1");
    expect(thread?.session?.approvalPolicy).toBe("on-request");
    expect(thread?.session?.sandboxMode).toBe("workspace-write");
  });

  it("generates and renames temporary worktree branch on first turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-meta-set-temp-branch"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        branch: "t3code/89abc123",
        worktreePath: "/tmp/provider-project/.t3/worktrees/t3code-89abc123",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-worktree-rename"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-worktree-rename"),
          role: "user",
          text: "Fix visual bug from screenshot",
          attachments: [
            {
              type: "image",
              name: "bug.png",
              mimeType: "image/png",
              sizeBytes: 5,
              dataUrl: "data:image/png;base64,SGVsbG8=",
            },
          ],
        },
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.renameBranch.mock.calls.length === 1);

    expect(harness.generateBranchName.mock.calls[0]?.[0]).toEqual({
      cwd: "/tmp/provider-project/.t3/worktrees/t3code-89abc123",
      message: "Fix visual bug from screenshot",
      attachments: [
        {
          type: "image",
          name: "bug.png",
          mimeType: "image/png",
          sizeBytes: 5,
          dataUrl: "data:image/png;base64,SGVsbG8=",
        },
      ],
    });
    expect(harness.renameBranch.mock.calls[0]?.[0]).toEqual({
      cwd: "/tmp/provider-project/.t3/worktrees/t3code-89abc123",
      oldBranch: "t3code/89abc123",
      newBranch: "t3code/generated-name",
    });

    await waitFor(() => {
      const readModel = Effect.runSync(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.branch === "t3code/generated-name";
    });
  });

  it("reuses persisted attachment files for branch generation and turn start", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-reactor-attachments-"));
    const harness = await createHarness({ stateDir });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-meta-set-temp-branch-persisted"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        branch: "t3code/abcdef12",
        worktreePath: "/tmp/provider-project/.t3/worktrees/t3code-abcdef12",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-persisted-attachments"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-persisted-attachments"),
          role: "user",
          text: "Fix visual bug from screenshot",
          attachments: [
            {
              type: "image",
              name: "bug.png",
              mimeType: "image/png",
              sizeBytes: 5,
              dataUrl: "data:image/png;base64,SGVsbG8=",
            },
          ],
        },
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const expectedAttachmentPath = path.join(
      stateDir,
      "attachments",
      "thread-1",
      "user-message-persisted-attachments-0.png",
    );

    expect(harness.generateBranchName.mock.calls[0]?.[0]).toEqual({
      cwd: "/tmp/provider-project/.t3/worktrees/t3code-abcdef12",
      message: "Fix visual bug from screenshot",
      attachments: [
        {
          type: "image",
          name: "bug.png",
          mimeType: "image/png",
          sizeBytes: 5,
          dataUrl: expectedAttachmentPath,
        },
      ],
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      attachments: [
        {
          type: "image",
          name: "bug.png",
          mimeType: "image/png",
          sizeBytes: 5,
          dataUrl: "data:image/png;base64,SGVsbG8=",
        },
      ],
    });
    expect(fs.existsSync(expectedAttachmentPath)).toBe(true);
  });

  it("skips worktree branch generation after the first user turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-meta-set-temp-branch-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/provider-project/.t3/worktrees/t3code-1234abcd",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-first"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-first"),
          role: "user",
          text: "first",
          attachments: [],
        },
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-second"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-second"),
          role: "user",
          text: "second",
          attachments: [],
        },
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.generateBranchName.mock.calls.length).toBe(1);
    expect(harness.renameBranch.mock.calls.length).toBe(1);
  });

  it("skips worktree rename when branch-name generation fails", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.generateBranchName.mockImplementationOnce(() =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "model returned invalid payload",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-meta-set-temp-branch-null"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        branch: "t3code/0000abcd",
        worktreePath: "/tmp/provider-project/.t3/worktrees/t3code-0000abcd",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-null-branch"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-null-branch"),
          role: "user",
          text: "Fix visual regression",
          attachments: [],
        },
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await Effect.runPromise(Effect.sleep("20 millis"));
    expect(harness.renameBranch.mock.calls.length).toBe(0);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.branch).toBe("t3code/0000abcd");
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts the provider session when runtime mode changes", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ sessionId: asSessionId("sess-1") });
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeThreadId: ProviderThreadId.makeUnsafe("provider-thread-1"),
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      sessionId: asSessionId("sess-2"),
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.providerSessionId).toBe("sess-2");
    expect(thread?.session?.approvalPolicy).toBe("on-request");
    expect(thread?.session?.sandboxMode).toBe("workspace-write");
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail(new Error("simulated restart failure")) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-restart-failure-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(Effect.sleep("30 millis"));

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.providerSessionId).toBe("sess-1");
    expect(thread?.session?.approvalPolicy).toBe("never");
    expect(thread?.session?.sandboxMode).toBe("danger-full-access");
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          providerSessionId: asSessionId("sess-1"),
          providerThreadId: ProviderThreadId.makeUnsafe("provider-thread-1"),
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      sessionId: "sess-1",
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-approval"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          providerSessionId: asSessionId("sess-1"),
          providerThreadId: ProviderThreadId.makeUnsafe("provider-thread-1"),
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      sessionId: "sess-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          providerSessionId: asSessionId("sess-1"),
          providerThreadId: ProviderThreadId.makeUnsafe("provider-thread-1"),
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-session-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.providerSessionId).toBeNull();
    expect(thread?.session?.providerThreadId).toBeNull();
    expect(thread?.session?.activeTurnId).toBeNull();
  });
});
