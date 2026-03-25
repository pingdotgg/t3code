import assert from "node:assert/strict";

import { ThreadId } from "@t3tools/contracts";
import { type SessionEvent } from "@github/copilot-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, it, vi } from "@effect/vitest";
import { beforeEach } from "vitest";

import { Effect, Fiber, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { CopilotAdapter } from "../Services/CopilotAdapter.ts";
import { makeCopilotAdapterLive } from "./CopilotAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

class FakeCopilotSession {
  public readonly sessionId: string;
  public readonly modelSwitchToImpl = vi.fn(
    async ({ modelId }: { modelId: string; reasoningEffort?: string }) => ({
      modelId,
    }),
  );

  public readonly modeSetImpl = vi.fn(
    async ({ mode }: { mode: "interactive" | "plan" | "autopilot" }) => ({
      mode,
    }),
  );

  public readonly planReadImpl = vi.fn(
    async (): Promise<{
      exists: boolean;
      content: string | null;
      path: string | null;
    }> => ({
      exists: false,
      content: null,
      path: null,
    }),
  );

  public readonly sendImpl = vi.fn(
    async (_options: { prompt: string; attachments?: unknown; mode?: string }) => "message-1",
  );

  public readonly abortImpl = vi.fn(async () => undefined);
  public readonly disconnectImpl = vi.fn(async () => undefined);
  public readonly destroyImpl = vi.fn(async () => undefined);
  public readonly getMessagesImpl = vi.fn(async () => [] as SessionEvent[]);

  private readonly handlers = new Set<(event: SessionEvent) => void>();

  public readonly rpc = {
    model: {
      switchTo: this.modelSwitchToImpl,
    },
    mode: {
      set: this.modeSetImpl,
    },
    plan: {
      read: this.planReadImpl,
    },
  };

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  on(handler: (event: SessionEvent) => void) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  send(options: { prompt: string; attachments?: unknown; mode?: string }) {
    return this.sendImpl(options);
  }

  abort() {
    return this.abortImpl();
  }

  disconnect() {
    return this.disconnectImpl();
  }

  destroy() {
    return this.destroyImpl();
  }

  getMessages() {
    return this.getMessagesImpl();
  }

  emit(event: SessionEvent) {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

class FakeCopilotClient {
  public readonly startImpl = vi.fn(async () => undefined);
  public readonly listModelsImpl = vi.fn(async () => []);
  public readonly createSessionImpl = vi.fn(async (_config: unknown) => this.session);
  public readonly resumeSessionImpl = vi.fn(
    async (_sessionId: string, _config: unknown) => this.session,
  );
  public readonly stopImpl = vi.fn(async () => [] as Error[]);

  constructor(private readonly session: FakeCopilotSession) {}

  start() {
    return this.startImpl();
  }

  listModels() {
    return this.listModelsImpl();
  }

  createSession(config: unknown) {
    return this.createSessionImpl(config);
  }

  resumeSession(sessionId: string, config: unknown) {
    return this.resumeSessionImpl(sessionId, config);
  }

  stop() {
    return this.stopImpl();
  }
}

function makeModelInfo(input: {
  id: string;
  name: string;
  supportedReasoningEfforts?: ReadonlyArray<"low" | "medium" | "high" | "xhigh">;
  defaultReasoningEffort?: "low" | "medium" | "high" | "xhigh";
}) {
  return input as unknown as import("@github/copilot-sdk").ModelInfo;
}

function makeCopilotModelSelection(
  model: string,
  reasoningEffort?: "low" | "medium" | "high" | "xhigh",
) {
  return {
    provider: "copilot" as const,
    model,
    ...(reasoningEffort ? { options: { reasoningEffort } } : {}),
  };
}

function diffDetailedContent(path: string) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
}

const modeSession = new FakeCopilotSession("copilot-session-mode");
const modeClient = new FakeCopilotClient(modeSession);
const modeLayer = it.layer(
  makeCopilotAdapterLive({
    clientFactory: () => modeClient,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

modeLayer("CopilotAdapterLive interaction mode", (it) => {
  it.effect("switches the Copilot session mode when interactionMode changes", () =>
    Effect.gen(function* () {
      modeSession.modeSetImpl.mockClear();
      modeSession.sendImpl.mockClear();

      const adapter = yield* CopilotAdapter;
      const session = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-mode"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Plan the work",
        interactionMode: "plan",
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Now execute it",
        interactionMode: "default",
        attachments: [],
      });

      assert.deepStrictEqual(modeSession.modeSetImpl.mock.calls, [
        [{ mode: "plan" }],
        [{ mode: "interactive" }],
      ]);
      assert.equal(modeSession.sendImpl.mock.calls[0]?.[0]?.mode, "enqueue");
      assert.equal(modeSession.sendImpl.mock.calls[1]?.[0]?.mode, "enqueue");
    }),
  );
});

const planSession = new FakeCopilotSession("copilot-session-plan");
const planClient = new FakeCopilotClient(planSession);
const planLayer = it.layer(
  makeCopilotAdapterLive({
    clientFactory: () => planClient,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

planLayer("CopilotAdapterLive proposed plan events", (it) => {
  it.effect("emits a proposed-plan completion event from Copilot plan updates", () =>
    Effect.gen(function* () {
      planSession.modeSetImpl.mockClear();
      planSession.planReadImpl.mockReset();
      planSession.planReadImpl.mockResolvedValue({
        exists: true,
        content: "# Ship it\n\n- first\n- second",
        path: "/tmp/copilot-session-plan/plan.md",
      });

      const adapter = yield* CopilotAdapter;
      const session = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-plan"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 4).pipe(Stream.runDrain);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Draft a plan",
        interactionMode: "plan",
        attachments: [],
      });

      const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      planSession.emit({
        id: "evt-plan-changed",
        timestamp: new Date().toISOString(),
        parentId: null,
        type: "session.plan_changed",
        data: {
          operation: "update",
        },
      } satisfies SessionEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events[0]?.type, "turn.plan.updated");
      if (events[0]?.type === "turn.plan.updated") {
        assert.equal(events[0].turnId, turn.turnId);
        assert.equal(events[0].payload.explanation, "Plan updated");
      }

      assert.equal(events[1]?.type, "turn.proposed.completed");
      if (events[1]?.type === "turn.proposed.completed") {
        assert.equal(events[1].turnId, turn.turnId);
        assert.equal(events[1].payload.planMarkdown, "# Ship it\n\n- first\n- second");
      }
    }),
  );
});

const reasoningSession = new FakeCopilotSession("copilot-session-reasoning");
const reasoningClient = new FakeCopilotClient(reasoningSession);
const reasoningLayer = it.layer(
  makeCopilotAdapterLive({
    clientFactory: () => reasoningClient,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

reasoningLayer("CopilotAdapterLive reasoning", (it) => {
  it.effect("passes reasoning effort when starting a session", () =>
    Effect.gen(function* () {
      reasoningClient.startImpl.mockClear();
      reasoningClient.listModelsImpl.mockReset();
      reasoningClient.createSessionImpl.mockClear();
      reasoningClient.listModelsImpl.mockResolvedValue([
        makeModelInfo({
          id: "gpt-5.4",
          name: "GPT-5.4",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
          defaultReasoningEffort: "medium",
        }),
      ] as never);

      const adapter = yield* CopilotAdapter;
      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-reasoning-start"),
        modelSelection: makeCopilotModelSelection("gpt-5.4", "high"),
        runtimeMode: "full-access",
      });

      assert.equal(reasoningClient.startImpl.mock.calls.length, 1);
      assert.equal(reasoningClient.listModelsImpl.mock.calls.length, 1);
      const createdConfig = reasoningClient.createSessionImpl.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      assert.equal(createdConfig.model, "gpt-5.4");
      assert.equal(createdConfig.reasoningEffort, "high");
      assert.equal(createdConfig.sessionId, "t3code-copilot-thread-reasoning-start");
      assert.equal(createdConfig.streaming, true);
      assert.equal(typeof createdConfig.onPermissionRequest, "function");
      assert.equal(typeof createdConfig.onUserInputRequest, "function");
    }),
  );

  it.effect("rejects a non-Copilot modelSelection", () =>
    Effect.gen(function* () {
      reasoningClient.startImpl.mockClear();
      reasoningClient.listModelsImpl.mockReset();
      reasoningClient.createSessionImpl.mockClear();

      const adapter = yield* CopilotAdapter;
      const result = yield* adapter
        .startSession({
          provider: "copilot",
          threadId: asThreadId("thread-reasoning-no-model"),
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "copilot",
          operation: "startSession",
          issue: "Expected modelSelection.provider 'copilot', received 'codex'.",
        }),
      );
      assert.equal(reasoningClient.startImpl.mock.calls.length, 0);
      assert.equal(reasoningClient.listModelsImpl.mock.calls.length, 0);
      assert.equal(reasoningClient.createSessionImpl.mock.calls.length, 0);
    }),
  );

  it.effect("rejects unsupported reasoning effort for a valid model", () =>
    Effect.gen(function* () {
      reasoningClient.startImpl.mockClear();
      reasoningClient.listModelsImpl.mockReset();
      reasoningClient.createSessionImpl.mockClear();
      reasoningClient.listModelsImpl.mockResolvedValue([
        makeModelInfo({
          id: "gpt-5.4",
          name: "GPT-5.4",
          supportedReasoningEfforts: ["low", "medium"],
        }),
      ] as never);

      const adapter = yield* CopilotAdapter;
      const result = yield* adapter
        .startSession({
          provider: "copilot",
          threadId: asThreadId("thread-reasoning-invalid"),
          modelSelection: makeCopilotModelSelection("gpt-5.4", "xhigh"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "copilot",
          operation: "session.reasoningEffort",
          issue: "GitHub Copilot model 'gpt-5.4' does not support reasoning effort 'xhigh'.",
        }),
      );
      assert.equal(reasoningClient.createSessionImpl.mock.calls.length, 0);
    }),
  );

  it.effect("reconfigures the session when reasoning effort changes", () =>
    Effect.gen(function* () {
      reasoningSession.modelSwitchToImpl.mockClear();
      reasoningSession.disconnectImpl.mockClear();
      reasoningSession.destroyImpl.mockClear();
      reasoningSession.sendImpl.mockClear();
      reasoningClient.startImpl.mockClear();
      reasoningClient.listModelsImpl.mockReset();
      reasoningClient.createSessionImpl.mockClear();
      reasoningClient.resumeSessionImpl.mockClear();
      reasoningClient.listModelsImpl.mockResolvedValue([
        makeModelInfo({
          id: "gpt-5.4",
          name: "GPT-5.4",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        }),
      ] as never);

      const adapter = yield* CopilotAdapter;
      const session = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-reasoning-reconfigure"),
        modelSelection: makeCopilotModelSelection("gpt-5.4", "high"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Switch effort",
        modelSelection: makeCopilotModelSelection("gpt-5.4", "low"),
        attachments: [],
      });

      assert.deepStrictEqual(reasoningSession.modelSwitchToImpl.mock.calls, [
        [{ modelId: "gpt-5.4", reasoningEffort: "low" }],
      ]);
      assert.equal(reasoningSession.disconnectImpl.mock.calls.length, 0);
      assert.equal(reasoningSession.destroyImpl.mock.calls.length, 0);
      assert.equal(reasoningClient.resumeSessionImpl.mock.calls.length, 0);
      assert.equal(reasoningSession.sendImpl.mock.calls.length, 1);
    }),
  );
});

let toolEventSession: FakeCopilotSession;
let toolEventClient: FakeCopilotClient;

beforeEach(() => {
  toolEventSession = new FakeCopilotSession("copilot-session-tool-events");
  toolEventClient = new FakeCopilotClient(toolEventSession);
});

const toolEventLayer = it.layer(
  makeCopilotAdapterLive({
    clientFactory: () => toolEventClient,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

toolEventLayer("CopilotAdapterLive tool event mapping", (it) => {
  it.effect("maps Copilot tool events to canonical lifecycle item types", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const session = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-tool-events"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 4).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Inspect and edit a file",
        attachments: [],
      });

      const eventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      toolEventSession.emit({
        id: "evt-tool-start-command",
        timestamp: new Date().toISOString(),
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-call-command",
          toolName: "bash",
        },
      } satisfies SessionEvent);
      toolEventSession.emit({
        id: "evt-tool-complete-command",
        timestamp: new Date().toISOString(),
        parentId: "evt-tool-start-command",
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-call-command",
          success: true,
          result: {
            content: "ok",
          },
        },
      } satisfies SessionEvent);
      toolEventSession.emit({
        id: "evt-tool-start-write",
        timestamp: new Date().toISOString(),
        parentId: "evt-tool-complete-command",
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-call-write",
          toolName: "write_file",
        },
      } satisfies SessionEvent);
      toolEventSession.emit({
        id: "evt-tool-complete-write",
        timestamp: new Date().toISOString(),
        parentId: "evt-tool-start-write",
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-call-write",
          success: true,
          result: {
            content: "done",
          },
        },
      } satisfies SessionEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber)).filter(
        (event) => event.type === "item.started" || event.type === "item.completed",
      );
      assert.deepStrictEqual(
        events.map((event) =>
          "payload" in event && event.payload && typeof event.payload === "object"
            ? {
                type: event.type,
                itemType: "itemType" in event.payload ? event.payload.itemType : undefined,
                title: "title" in event.payload ? event.payload.title : undefined,
              }
            : { type: event.type, itemType: undefined, title: undefined },
        ),
        [
          { type: "item.started", itemType: "command_execution", title: "Command run" },
          { type: "item.completed", itemType: "command_execution", title: "Command run" },
          { type: "item.started", itemType: "file_change", title: "File change" },
          { type: "item.completed", itemType: "file_change", title: "File change" },
        ],
      );
    }),
  );
});

let toolTitleSession: FakeCopilotSession;
let toolTitleClient: FakeCopilotClient;

beforeEach(() => {
  toolTitleSession = new FakeCopilotSession("copilot-session-tool-titles");
  toolTitleClient = new FakeCopilotClient(toolTitleSession);
});

const toolTitleLayer = it.layer(
  makeCopilotAdapterLive({
    clientFactory: () => toolTitleClient,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

toolTitleLayer("CopilotAdapterLive tool titles", (it) => {
  it.effect("uses specific titles for Copilot SDK read and search tools", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const session = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-tool-titles"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 4).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Read and search files",
        attachments: [],
      });

      const eventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      toolTitleSession.emit({
        id: "evt-tool-start-view",
        timestamp: new Date().toISOString(),
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-call-view",
          toolName: "view",
          arguments: {
            path: "README.md",
          },
        },
      } satisfies SessionEvent);
      toolTitleSession.emit({
        id: "evt-tool-complete-view",
        timestamp: new Date().toISOString(),
        parentId: "evt-tool-start-view",
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-call-view",
          success: true,
          result: {
            content: "read ok",
          },
        },
      } satisfies SessionEvent);
      toolTitleSession.emit({
        id: "evt-tool-start-grep",
        timestamp: new Date().toISOString(),
        parentId: "evt-tool-complete-view",
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-call-grep",
          toolName: "grep",
          arguments: {
            pattern: "Copilot",
          },
        },
      } satisfies SessionEvent);
      toolTitleSession.emit({
        id: "evt-tool-complete-grep",
        timestamp: new Date().toISOString(),
        parentId: "evt-tool-start-grep",
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-call-grep",
          success: true,
          result: {
            content: "match",
          },
        },
      } satisfies SessionEvent);
      toolTitleSession.emit({
        id: "evt-tool-start-list-directory",
        timestamp: new Date().toISOString(),
        parentId: "evt-tool-complete-grep",
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-call-list-directory",
          toolName: "list_directory",
          arguments: {
            path: ".",
          },
        },
      } satisfies SessionEvent);
      toolTitleSession.emit({
        id: "evt-tool-complete-list-directory",
        timestamp: new Date().toISOString(),
        parentId: "evt-tool-start-list-directory",
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-call-list-directory",
          success: true,
          result: {
            content: "listed",
          },
        },
      } satisfies SessionEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber)).filter(
        (event) => event.type === "item.completed",
      );
      assert.deepStrictEqual(
        events.map((event) =>
          event.payload && typeof event.payload === "object"
            ? {
                itemType: event.payload.itemType,
                title: event.payload.title,
                detail: event.payload.detail,
              }
            : null,
        ),
        [
          {
            itemType: "dynamic_tool_call",
            title: "Read file",
            detail: "README.md",
          },
          {
            itemType: "dynamic_tool_call",
            title: "Grep",
            detail: "Copilot",
          },
          {
            itemType: "dynamic_tool_call",
            title: "List directory",
            detail: ".",
          },
        ],
      );
    }),
  );

  it.effect("uses detailedContent for completed tool detail and content for tool summary", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const session = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-tool-detailed-content"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 4).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Inspect a diff",
        attachments: [],
      });

      const eventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      toolTitleSession.emit({
        id: "evt-tool-start-detailed",
        timestamp: new Date().toISOString(),
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-call-detailed",
          toolName: "edit",
        },
      } satisfies SessionEvent);
      toolTitleSession.emit({
        id: "evt-tool-complete-detailed",
        timestamp: new Date().toISOString(),
        parentId: "evt-tool-start-detailed",
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-call-detailed",
          success: true,
          result: {
            content: "Updated file",
            detailedContent: "Updated file\n--- a/file.ts\n+++ b/file.ts\n+const value = 1;",
          },
        },
      } satisfies SessionEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const completedEvent = events.find((event) => event.type === "item.completed");
      const summaryEvent = events.find((event) => event.type === "tool.summary");

      assert.equal(completedEvent?.type, "item.completed");
      if (completedEvent?.type === "item.completed") {
        assert.equal(
          completedEvent.payload.detail,
          "Updated file\n--- a/file.ts\n+++ b/file.ts\n+const value = 1;",
        );
      }

      assert.equal(summaryEvent?.type, "tool.summary");
      if (summaryEvent?.type === "tool.summary") {
        assert.equal(summaryEvent.payload.summary, "Updated file");
      }
    }),
  );

  it.effect("keeps diff-like detailedContent from read tools as a read-style tool call", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const session = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-tool-diff-file-change"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 4).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Apply a patch",
        attachments: [],
      });

      const eventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      toolTitleSession.emit({
        id: "evt-tool-start-diff",
        timestamp: new Date().toISOString(),
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-call-diff",
          toolName: "view",
          arguments: {
            path: "apps/web/src/foo.ts",
          },
        },
      } satisfies SessionEvent);
      toolTitleSession.emit({
        id: "evt-tool-complete-diff",
        timestamp: new Date().toISOString(),
        parentId: "evt-tool-start-diff",
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-call-diff",
          success: true,
          result: {
            content: "Updated file",
            detailedContent: diffDetailedContent("apps/web/src/foo.ts"),
          },
        },
      } satisfies SessionEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const completedEvent = events.find((event) => event.type === "item.completed");

      assert.equal(completedEvent?.type, "item.completed");
      if (completedEvent?.type === "item.completed") {
        assert.equal(completedEvent.payload.itemType, "dynamic_tool_call");
        assert.equal(completedEvent.payload.title, "Read file");
        assert.equal(completedEvent.payload.detail, "apps/web/src/foo.ts");
        assert.deepStrictEqual(
          (completedEvent.payload.data as { changes?: Array<{ path: string }> }).changes,
          undefined,
        );
      }
    }),
  );

  it.effect("maps diff-like detailedContent from edit tools to a file change completion", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const session = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-tool-edit-diff-file-change"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 4).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Apply an edit",
        attachments: [],
      });

      const eventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      toolTitleSession.emit({
        id: "evt-tool-start-edit-diff",
        timestamp: new Date().toISOString(),
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-call-edit-diff",
          toolName: "edit",
          arguments: {
            path: "apps/web/src/foo.ts",
          },
        },
      } satisfies SessionEvent);
      toolTitleSession.emit({
        id: "evt-tool-complete-edit-diff",
        timestamp: new Date().toISOString(),
        parentId: "evt-tool-start-edit-diff",
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-call-edit-diff",
          success: true,
          result: {
            content: "Updated file",
            detailedContent: diffDetailedContent("apps/web/src/foo.ts"),
          },
        },
      } satisfies SessionEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const completedEvent = events.find((event) => event.type === "item.completed");

      assert.equal(completedEvent?.type, "item.completed");
      if (completedEvent?.type === "item.completed") {
        assert.equal(completedEvent.payload.itemType, "file_change");
        assert.equal(completedEvent.payload.title, "File change");
        assert.equal(completedEvent.payload.detail, "apps/web/src/foo.ts");
        assert.deepStrictEqual(
          (completedEvent.payload.data as { changes?: Array<{ path: string }> }).changes,
          [{ path: "apps/web/src/foo.ts" }],
        );
      }
    }),
  );
});

afterAll(() => {
  void modeSession.disconnect();
  void modeClient.stop();
  void planSession.disconnect();
  void planClient.stop();
  void reasoningSession.disconnect();
  void reasoningClient.stop();
  void toolEventSession.disconnect();
  void toolEventClient.stop();
  void toolTitleSession.disconnect();
  void toolTitleClient.stop();
});
