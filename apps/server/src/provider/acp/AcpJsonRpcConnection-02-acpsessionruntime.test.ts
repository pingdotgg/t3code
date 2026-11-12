// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as EffectAcpErrors from "effect-acp/errors";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = "node";
const mockAgentArgs = [mockAgentPath];
const mockRuntimeOptions = {
  spawn: { command: mockAgentCommand, args: mockAgentArgs },
  cwd: process.cwd(),
  clientInfo: { name: "t3-test", version: "0.0.0" },
  authMethodId: "test",
} satisfies AcpSessionRuntime.AcpSessionRuntimeOptions;



describe("AcpSessionRuntime", () => {
  it.effect("starts a session, prompts, and emits normalized events against the mock agent", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.initializeResult).toMatchObject({ protocolVersion: 2 });
      expect(started.sessionId).toBe("mock-session-1");

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      expect(notes).toHaveLength(4);
      expect(notes.map((note) => note._tag)).toEqual([
        "PlanUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      const planUpdate = notes.find((note) => note._tag === "PlanUpdated");
      expect(planUpdate?._tag).toBe("PlanUpdated");
      if (planUpdate?._tag === "PlanUpdated") {
        expect(planUpdate.payload).toMatchObject({
          nativePlanId: "mock-plan",
          kind: "items",
        });
        if (planUpdate.payload.kind === "items") {
          expect(planUpdate.payload.plan).toHaveLength(2);
        }
      }
      const assistantStart = notes[1];
      const assistantDelta = notes[2];
      if (
        assistantStart?._tag === "AssistantItemStarted" &&
        assistantDelta?._tag === "ContentDelta"
      ) {
        expect(assistantDelta.itemId).toBe(assistantStart.itemId);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
  it.effect("keeps assistant item IDs unique when a provider session restarts", () => {
    const collectFirstAssistantItemId = Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.sessionId).toBe("mock-session-1");

      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });

      const events = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      const assistantStart = events.find((event) => event._tag === "AssistantItemStarted");
      expect(assistantStart?._tag).toBe("AssistantItemStarted");
      return assistantStart?._tag === "AssistantItemStarted" ? assistantStart.itemId : "";
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
    );

    return Effect.gen(function* () {
      const beforeRestart = yield* collectFirstAssistantItemId;
      const afterRestart = yield* collectFirstAssistantItemId;

      expect(afterRestart).not.toBe(beforeRestart);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  });
  it.effect("drops session updates emitted for a child ACP session", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      expect(notes.map((note) => note._tag)).toEqual([
        "AssistantItemStarted",
        "ContentDelta",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      expect(
        notes
          .filter((note) => note._tag === "ContentDelta")
          .map((note) => note.text)
          .join(""),
      ).toBe("root before child root after child");
      expect(notes.some((note) => note._tag === "ToolCallUpdated")).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              T3_ACP_EMIT_FOREIGN_SESSION_UPDATES: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
  it.effect("segments assistant text around ACP tool calls", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 7)));
      expect(notes.map((note) => note._tag)).toEqual([
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
        "ToolCallUpdated",
        "ToolCallUpdated",
        "AssistantItemStarted",
        "ContentDelta",
      ]);

      const firstStarted = notes[0];
      const firstDelta = notes[1];
      const firstCompleted = notes[2];
      const secondStarted = notes[5];
      const secondDelta = notes[6];
      expect(firstStarted?._tag).toBe("AssistantItemStarted");
      expect(firstCompleted?._tag).toBe("AssistantItemCompleted");
      expect(secondStarted?._tag).toBe("AssistantItemStarted");
      if (
        firstStarted?._tag === "AssistantItemStarted" &&
        firstDelta?._tag === "ContentDelta" &&
        firstCompleted?._tag === "AssistantItemCompleted" &&
        secondStarted?._tag === "AssistantItemStarted" &&
        secondDelta?._tag === "ContentDelta"
      ) {
        expect(firstDelta.itemId).toBe(firstStarted.itemId);
        expect(firstCompleted.itemId).toBe(firstStarted.itemId);
        expect(secondStarted.itemId).not.toBe(firstStarted.itemId);
        expect(secondDelta.itemId).toBe(secondStarted.itemId);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
  it.effect("keeps one answer when an earlier tool reports progress mid-stream", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();
      yield* runtime.prompt({ prompt: [{ type: "text", text: "hi" }] });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 9)));
      expect(notes.map((note) => note._tag)).toEqual([
        "ToolCallUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "ContentDelta",
        "ToolCallUpdated",
        "ContentDelta",
        "ToolCallUpdated",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      const itemIds = new Set(
        notes.flatMap((note) =>
          note._tag === "ContentDelta" ||
          note._tag === "AssistantItemStarted" ||
          note._tag === "AssistantItemCompleted"
            ? [note.itemId]
            : [],
        ),
      );
      expect(itemIds.size).toBe(1);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { T3_ACP_EMIT_BACKGROUND_TOOL_DURING_ANSWER: "1" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
  it.effect("emits status-only tool updates through completion", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 3)));
      expect(notes.map((note) => note._tag)).toEqual([
        "ToolCallUpdated",
        "ToolCallUpdated",
        "ToolCallUpdated",
      ]);
      const toolCalls = notes.flatMap((note) =>
        note._tag === "ToolCallUpdated" ? [note.toolCall] : [],
      );
      expect(toolCalls.map((toolCall) => toolCall.status)).toEqual([
        "pending",
        "inProgress",
        "completed",
      ]);
      for (const toolCall of toolCalls) {
        expect(toolCall.title).toBe("Read file");
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
  it.effect("supports negotiated ACP session list, fork, resume, and close methods", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult.agentCapabilities?.sessionCapabilities).toMatchObject({
        list: {},
        fork: {},
        resume: {},
        close: {},
      });
      expect(started.initializeResult.agentCapabilities?.auth).toMatchObject({ logout: {} });

      const listed = yield* runtime.listSessions();
      expect(listed.sessions.map((session) => session.sessionId)).toEqual(["mock-session-1"]);

      const forked = yield* runtime.forkSession(started.sessionId);
      expect(forked.sessionId).toBe("mock-session-1-fork");
      yield* runtime.prompt({ prompt: [{ type: "text", text: "on fork" }] });

      const resumed = yield* runtime.resumeSession(started.sessionId);
      expect(resumed.sessionId).toBe("mock-session-1");
      yield* runtime.closeSession();
      yield* runtime.logout;

      expect(
        requestEvents.find(
          (event) => event.method === "session/prompt" && event.status === "started",
        )?.payload,
      ).toMatchObject({ sessionId: "mock-session-1-fork" });
      expect(
        requestEvents.filter((event) => event.status === "started").map((event) => event.method),
      ).toEqual(
        expect.arrayContaining([
          "session/list",
          "session/fork",
          "session/resume",
          "session/close",
          "logout",
        ]),
      );
      // Omitted roots clear an agent's stored ones, so every activation resends them.
      for (const method of ["session/new", "session/fork", "session/resume"]) {
        expect(
          requestEvents.find((event) => event.method === method && event.status === "started")
            ?.payload,
        ).toMatchObject({
          additionalDirectories: ["/tmp/t3-attachments"],
          _meta: { negotiated: "0.0.0" },
        });
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              T3_ACP_SESSION_LIFECYCLE: "1",
            },
          },
          additionalDirectories: ["/tmp/t3-attachments"],
          sessionMeta: (initializeResult) => ({
            negotiated: initializeResult.agentInfo?.version ?? "none",
          }),
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
  });
  it.effect("rejects unauthenticated ACP session lifecycle requests", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const listError = yield* runtime.listSessions().pipe(Effect.flip);
      expect(listError._tag).toBe("AcpRequestError");
      if (listError._tag === "AcpRequestError") {
        expect(listError.code).toBe(-32000);
      }

      const forkError = yield* runtime.forkSession("mock-session-1").pipe(Effect.flip);
      expect(forkError._tag).toBe("AcpRequestError");
      if (forkError._tag === "AcpRequestError") {
        expect(forkError.code).toBe(-32000);
      }

      const resumeError = yield* runtime.resumeSession("mock-session-1").pipe(Effect.flip);
      expect(resumeError._tag).toBe("AcpRequestError");
      if (resumeError._tag === "AcpRequestError") {
        expect(resumeError.code).toBe(-32000);
      }

      const closeError = yield* runtime.closeSession().pipe(Effect.flip);
      expect(closeError._tag).toBe("AcpRequestError");
      if (closeError._tag === "AcpRequestError") {
        expect(closeError.code).toBe(-32000);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              T3_ACP_REQUIRE_AUTH: "1",
              T3_ACP_SESSION_LIFECYCLE: "1",
            },
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          clientInfo: { name: "t3-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
  it.effect("fails session startup when session/load returns an error", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const error = yield* runtime.start().pipe(Effect.flip);

      expect(error._tag).toBe("AcpRequestError");
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              T3_ACP_FAIL_LOAD_SESSION: "1",
            },
          },
          cwd: process.cwd(),
          resumeSessionId: "stale-session-id",
          clientInfo: { name: "t3-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
  it.effect("keeps active configuration after a candidate session load fails", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();
      const before = yield* runtime.getConfigOptions;

      const error = yield* runtime.loadSession("candidate-session").pipe(Effect.flip);

      expect(error._tag).toBe("AcpRequestError");
      expect(yield* runtime.getConfigOptions).toEqual(before);
      expect(before.some((option) => option.id === "candidate-only")).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              T3_ACP_FAIL_LOAD_SESSION_AFTER_CONFIG_REPLAY: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
  it.effect("ignores session/update replay notifications during session/load", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      expect(notes.map((note) => note._tag)).toEqual([
        "PlanUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      expect(notes.some((note) => note._tag === "ToolCallUpdated")).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              T3_ACP_EMIT_LOAD_REPLAY: "1",
            },
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          clientInfo: { name: "t3-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
  it.effect("rejects invalid config option values before sending session/set_config_option", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-runtime-"));
    const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const error = yield* runtime.setModel("composer-2[fast=false]").pipe(Effect.flip);
      expect(error._tag).toBe("AcpRequestError");
      if (error._tag === "AcpRequestError") {
        expect(error.code).toBe(-32602);
        expect(error.message).toContain(
          'Invalid value "composer-2[fast=false]" for session config option "model"',
        );
        expect(error.message).toContain("composer-2[fast=true]");
      }

      const recordedRequests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { method?: string; params?: { value?: unknown } });
      expect(
        recordedRequests.some(
          (message) =>
            message.method === "session/set_config_option" &&
            message.params?.value === "composer-2[fast=false]",
        ),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });
  it.effect("sends configured custom models the agent does not advertise", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-runtime-"));
    const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.setModel("cline-free/custom-model");
      const error = yield* runtime.setModel("unconfigured/model").pipe(Effect.flip);
      expect(error._tag).toBe("AcpRequestError");

      const sentModels = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { method?: string; params?: { value?: unknown } })
        .filter((message) => message.method === "session/set_config_option")
        .map((message) => message.params?.value);
      expect(sentModels).toEqual(["cline-free/custom-model"]);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          ...mockRuntimeOptions,
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath },
          },
          customModels: ["cline-free/custom-model"],
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });
});

