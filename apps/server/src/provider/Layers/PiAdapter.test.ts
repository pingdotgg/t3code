import { describe, expect, it, vi } from "@effect/vitest";
import {
  ApprovalRequestId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ProviderAdapterValidationError, type ProviderAdapterError } from "../Errors.ts";
import type {
  PiExtensionUiResponse,
  PiPromptInput,
  PiSessionRuntimeOptions,
  PiSessionRuntimeShape,
} from "../Drivers/PiSessionRuntime.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const PI = ProviderDriverKind.make("pi");
const INSTANCE_A = ProviderInstanceId.make("pi_personal");
const INSTANCE_B = ProviderInstanceId.make("pi_work");
const THREAD_ID = ThreadId.make("thread-native");

function makeRuntimeFactory(input?: { readonly thinkingLevels?: ReadonlyArray<string> }) {
  return Effect.gen(function* () {
    const options: PiSessionRuntimeOptions[] = [];
    const modelCalls: Array<{ provider: string; modelId: string }> = [];
    const thinkingCalls: string[] = [];
    const prompts: PiPromptInput[] = [];
    const extensionUiResponses: PiExtensionUiResponse[] = [];
    const events = yield* PubSub.unbounded<unknown>();
    let abortCount = 0;
    let closeCount = 0;

    const factory = (runtimeOptions: PiSessionRuntimeOptions) => {
      options.push(runtimeOptions);
      const runtime: PiSessionRuntimeShape & {
        readonly prompt: (input: PiPromptInput) => Effect.Effect<void>;
        readonly abort: () => Effect.Effect<void>;
        readonly respondToExtensionUI: (response: PiExtensionUiResponse) => Effect.Effect<void>;
      } = {
        start: () =>
          Effect.succeed({
            sessionId: runtimeOptions.sessionId ?? "probe",
            sessionFile: "/tmp/pi-session.jsonl",
            model: { provider: "custom", id: "starter", name: "Starter" },
            thinkingLevel: "high",
          }),
        getState: () =>
          Effect.succeed({
            sessionId: runtimeOptions.sessionId ?? "probe",
            model: { provider: "custom", id: "team/coder", name: "Team Coder" },
            thinkingLevel: thinkingCalls.at(-1) ?? "high",
          }),
        getAvailableModels: () => Effect.succeed([]),
        setModel: (model) =>
          Effect.sync(() => {
            modelCalls.push(model);
          }),
        getAvailableThinkingLevels: () =>
          Effect.succeed(input?.thinkingLevels ?? ["off", "high", "max"]),
        setThinkingLevel: (level) =>
          Effect.sync(() => {
            thinkingCalls.push(level);
          }),
        prompt: (prompt) =>
          Effect.sync(() => {
            prompts.push(prompt);
          }),
        abort: () =>
          Effect.sync(() => {
            abortCount += 1;
          }),
        respondToExtensionUI: (response) =>
          Effect.sync(() => {
            extensionUiResponses.push(response);
          }),
        events: Stream.fromPubSub(events),
        close: Effect.sync(() => {
          closeCount += 1;
        }),
      };
      return Effect.succeed(runtime);
    };

    return {
      factory,
      options,
      modelCalls,
      thinkingCalls,
      prompts,
      getExtensionUiResponses: () => extensionUiResponses,
      emit: (event: unknown) => PubSub.publish(events, event).pipe(Effect.asVoid),
      getAbortCount: () => abortCount,
      getCloseCount: () => closeCount,
    };
  });
}

const sessionStart = (
  instanceId: ProviderInstanceId,
  options?: ReadonlyArray<{ id: string; value: string }>,
) => ({
  threadId: THREAD_ID,
  provider: PI,
  providerInstanceId: instanceId,
  cwd: "/workspace/project",
  runtimeMode: "full-access" as const,
  modelSelection: {
    instanceId,
    model: "custom/team%2Fcoder",
    ...(options ? { options } : {}),
  },
});

describe("PiAdapter", () => {
  it.effect("starts Pi persistent mode with a stable T3 ID and applies model capabilities", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const adapter = yield* makePiAdapter(
        decodePiSettings({ binaryPath: "pi-custom", configDirectory: "/tmp/pi-config" }),
        {
          instanceId: INSTANCE_A,
          sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
          environment: { EXAMPLE: "value" },
          makeRuntime: runtime.factory,
        },
      );

      const session = yield* adapter.startSession(
        sessionStart(INSTANCE_A, [{ id: "reasoningEffort", value: "max" }]),
      );

      expect(runtime.options).toEqual([
        {
          binaryPath: "pi-custom",
          configDirectory: "/tmp/pi-config",
          launchArgs: "",
          cwd: "/workspace/project",
          environment: { EXAMPLE: "value" },
          sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
          sessionId: "thread-native",
        },
      ]);
      expect(runtime.modelCalls).toEqual([{ provider: "custom", modelId: "team/coder" }]);
      expect(runtime.thinkingCalls).toEqual(["max"]);
      expect(session).toMatchObject({
        provider: "pi",
        providerInstanceId: INSTANCE_A,
        threadId: THREAD_ID,
        model: "custom/team%2Fcoder",
        resumeCursor: { schemaVersion: 1, sessionId: "thread-native" },
      });

      yield* adapter.stopSession(THREAD_ID);
      expect(runtime.getCloseCount()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a session start routed to another Pi runtime instance", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });

      const error = yield* adapter.startSession(sessionStart(INSTANCE_B)).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProviderAdapterValidationError);
      expect((error as ProviderAdapterError).message).toContain("Expected Pi runtime instance");
      expect(runtime.options).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a thinking level Pi did not report for the selected model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory({ thinkingLevels: ["off", "high"] });
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });

      const error = yield* adapter
        .startSession(sessionStart(INSTANCE_A, [{ id: "reasoningEffort", value: "max" }]))
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProviderAdapterValidationError);
      expect((error as ProviderAdapterError).message).toContain(
        "does not support thinking level 'max'",
      );
      expect(runtime.thinkingCalls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("switches the live Pi session through native model and thinking RPC commands", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });
      yield* adapter.startSession(sessionStart(INSTANCE_A));

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "switch model before prompt delivery",
        attachments: [],
        modelSelection: {
          instanceId: INSTANCE_A,
          model: "custom/team%2Fcoder",
          options: [{ id: "reasoningEffort", value: "max" }],
        },
      });

      expect(runtime.modelCalls).toEqual([
        { provider: "custom", modelId: "team/coder" },
        { provider: "custom", modelId: "team/coder" },
      ]);
      expect(runtime.thinkingCalls).toEqual(["max"]);
      expect(runtime.prompts).toEqual([{ message: "switch model before prompt delivery" }]);
      expect((yield* adapter.listSessions())[0]?.model).toBe("custom/team%2Fcoder");
      expect(adapter.capabilities.sessionModelSwitch).toBe("in-session");
    }).pipe(Effect.scoped),
  );

  it.effect("delivers a native Pi prompt and starts a normal T3 turn", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });
      yield* adapter.startSession(sessionStart(INSTANCE_A));

      const started = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Inspect the project",
        attachments: [],
      });

      expect(runtime.prompts).toEqual([{ message: "Inspect the project" }]);
      expect(started).toMatchObject({
        threadId: THREAD_ID,
        resumeCursor: { schemaVersion: 1, sessionId: "thread-native" },
      });
      expect(started.turnId).toBeTruthy();
    }).pipe(Effect.scoped),
  );

  it.effect("round-trips compatible Pi extension dialogs through T3 user input", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* adapter.startSession(sessionStart(INSTANCE_A));
      yield* Effect.yieldNow;

      yield* runtime.emit({
        type: "extension_ui_request",
        id: "dialog-confirm",
        method: "confirm",
        title: "Deploy release",
        message: "Deploy this release to production?",
      });
      yield* runtime.emit({
        type: "extension_ui_request",
        id: "dialog-select",
        method: "select",
        title: "Choose environment",
        options: ["Staging", "Production"],
      });
      yield* runtime.emit({
        type: "extension_ui_request",
        id: "dialog-input",
        method: "input",
        title: "Release summary",
        placeholder: "Describe the release",
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "user-input.requested",
            requestId: "dialog-confirm",
            payload: {
              questions: [
                {
                  id: "dialog-confirm",
                  header: "Deploy release",
                  question: "Deploy this release to production?",
                  options: [
                    { label: "Confirm", description: "Confirm" },
                    { label: "Cancel", description: "Cancel" },
                  ],
                  multiSelect: false,
                },
              ],
            },
          }),
          expect.objectContaining({
            type: "user-input.requested",
            requestId: "dialog-select",
            payload: {
              questions: [
                {
                  id: "dialog-select",
                  header: "Choose environment",
                  question: "Choose an option.",
                  options: [
                    { label: "Staging", description: "Staging" },
                    { label: "Production", description: "Production" },
                  ],
                  multiSelect: false,
                },
              ],
            },
          }),
          expect.objectContaining({
            type: "user-input.requested",
            requestId: "dialog-input",
            payload: {
              questions: [
                {
                  id: "dialog-input",
                  header: "Release summary",
                  question: "Describe the release",
                  options: [{ label: "Cancel", description: "Cancel this input request" }],
                  cancelOptionLabel: "Cancel",
                  multiSelect: false,
                },
              ],
            },
          }),
        ]),
      );

      yield* adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.make("dialog-confirm"), {
        "dialog-confirm": "Confirm",
      });
      yield* adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.make("dialog-select"), {
        "dialog-select": "Production",
      });
      yield* adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.make("dialog-input"), {
        "dialog-input": { value: "Cancel" },
      });
      yield* Effect.yieldNow;

      expect(runtime.getExtensionUiResponses()).toEqual([
        { id: "dialog-confirm", confirmed: true },
        { id: "dialog-select", value: "Production" },
        { id: "dialog-input", value: "Cancel" },
      ]);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "user-input.resolved",
            requestId: "dialog-confirm",
            payload: { answers: { "dialog-confirm": "Confirm" } },
          }),
          expect.objectContaining({
            type: "user-input.resolved",
            requestId: "dialog-select",
            payload: { answers: { "dialog-select": "Production" } },
          }),
          expect.objectContaining({
            type: "user-input.resolved",
            requestId: "dialog-input",
            payload: { answers: { "dialog-input": { value: "Cancel" } } },
          }),
        ]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("maps selected Pi input cancellation back to the native RPC response", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });
      yield* adapter.startSession(sessionStart(INSTANCE_A));
      yield* Effect.yieldNow;
      yield* runtime.emit({
        type: "extension_ui_request",
        id: "dialog-input-cancel",
        method: "input",
        title: "Release summary",
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      yield* adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.make("dialog-input-cancel"), {
        "dialog-input-cancel": { cancelled: true },
      });

      expect(runtime.getExtensionUiResponses()).toEqual([
        { id: "dialog-input-cancel", cancelled: true },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("surfaces Pi extension UI that requires Pi's terminal interface", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* adapter.startSession(sessionStart(INSTANCE_A));
      yield* Effect.yieldNow;

      yield* runtime.emit({
        type: "extension_ui_request",
        id: "widget-status",
        method: "setWidget",
        widgetKey: "release-status",
        widgetLines: ["Deploying..."],
      });
      yield* runtime.emit({
        type: "extension_ui_request",
        id: "editor-dialog",
        method: "editor",
        title: "Edit release notes",
        prefill: "Initial notes",
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "runtime.warning",
            payload: expect.objectContaining({
              message: "Pi extension UI 'setWidget' requires Pi's terminal interface.",
            }),
          }),
          expect.objectContaining({
            type: "runtime.warning",
            payload: expect.objectContaining({
              message: "Pi extension UI 'editor' requires Pi's terminal interface.",
            }),
          }),
        ]),
      );
      expect(runtime.getExtensionUiResponses()).toEqual([{ id: "editor-dialog", cancelled: true }]);
    }).pipe(Effect.scoped),
  );

  it.effect("streams Pi text into a completed T3 turn", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });
      const events: Array<{ readonly type: string; readonly payload: unknown }> = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* adapter.startSession(sessionStart(INSTANCE_A));
      yield* Effect.yieldNow;
      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Say hello",
        attachments: [],
      });

      yield* runtime.emit({ type: "message_start", message: { role: "assistant" } });
      yield* runtime.emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello from Pi" },
      });
      yield* runtime.emit({ type: "message_end", message: { role: "assistant" } });
      yield* runtime.emit({ type: "agent_settled" });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "turn.started", turnId: turn.turnId }),
          expect.objectContaining({
            type: "content.delta",
            turnId: turn.turnId,
            payload: expect.objectContaining({
              streamKind: "assistant_text",
              delta: "Hello from Pi",
            }),
          }),
          expect.objectContaining({
            type: "turn.completed",
            turnId: turn.turnId,
            payload: { state: "completed" },
          }),
        ]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("maps Pi thinking deltas into visible work-log progress", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });
      const events: Array<{ readonly type: string; readonly payload: unknown }> = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* adapter.startSession(sessionStart(INSTANCE_A));
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Think through the implementation",
        attachments: [],
      });

      yield* runtime.emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
      });
      yield* runtime.emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "First inspect the session state.",
        },
      });
      yield* runtime.emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
      });
      yield* runtime.emit({ type: "agent_settled" });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "task.started",
            payload: expect.objectContaining({ description: "Thinking" }),
          }),
          expect.objectContaining({
            type: "task.progress",
            payload: expect.objectContaining({
              description: "Thinking",
              summary: "First inspect the session state.",
            }),
          }),
          expect.objectContaining({
            type: "task.completed",
            payload: expect.objectContaining({
              status: "completed",
              summary: "First inspect the session state.",
            }),
          }),
        ]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("maps Pi tool execution progress and results into work-log lifecycle events", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });
      const events: Array<{ readonly type: string; readonly payload: unknown }> = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* adapter.startSession(sessionStart(INSTANCE_A));
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Run the status command",
        attachments: [],
      });

      yield* runtime.emit({
        type: "tool_execution_start",
        toolCallId: "call-status",
        toolName: "bash",
        args: { command: "git status --short" },
      });
      yield* runtime.emit({
        type: "tool_execution_update",
        toolCallId: "call-status",
        toolName: "bash",
        args: { command: "git status --short" },
        partialResult: { content: [{ type: "text", text: "M package.json" }] },
      });
      yield* runtime.emit({
        type: "tool_execution_end",
        toolCallId: "call-status",
        toolName: "bash",
        result: { content: [{ type: "text", text: "M package.json\n" }] },
        isError: false,
      });
      yield* runtime.emit({ type: "agent_settled" });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "item.started",
            payload: expect.objectContaining({
              itemType: "command_execution",
              status: "inProgress",
              title: "bash",
              data: expect.objectContaining({
                toolCallId: "call-status",
                command: "git status --short",
              }),
            }),
          }),
          expect.objectContaining({
            type: "item.updated",
            payload: expect.objectContaining({
              itemType: "command_execution",
              status: "inProgress",
              detail: "M package.json",
            }),
          }),
          expect.objectContaining({
            type: "item.completed",
            payload: expect.objectContaining({
              itemType: "command_execution",
              status: "completed",
              detail: "M package.json",
            }),
          }),
        ]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("maps Pi constructed tool calls before native execution begins", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });
      const events: Array<{ readonly type: string; readonly payload: unknown }> = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* adapter.startSession(sessionStart(INSTANCE_A));
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Construct a status command",
        attachments: [],
      });

      yield* runtime.emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          id: "call-constructed-status",
          toolName: "bash",
        },
      });
      yield* runtime.emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"command":"git status --short"}',
        },
      });
      yield* runtime.emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: {
            type: "toolCall",
            id: "call-constructed-status",
            name: "bash",
            arguments: { command: "git status --short" },
          },
        },
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "item.started",
            payload: expect.objectContaining({
              itemType: "command_execution",
              status: "inProgress",
              title: "bash",
              data: expect.objectContaining({ toolCallId: "call-constructed-status" }),
            }),
            raw: expect.objectContaining({
              messageType: "message_update",
              payload: expect.objectContaining({
                assistantMessageEvent: expect.objectContaining({ type: "toolcall_start" }),
              }),
            }),
          }),
          expect.objectContaining({
            type: "item.updated",
            payload: expect.objectContaining({
              itemType: "command_execution",
              status: "inProgress",
              title: "bash",
              detail: "git status --short",
              data: expect.objectContaining({
                toolCallId: "call-constructed-status",
                command: "git status --short",
              }),
            }),
            raw: expect.objectContaining({
              messageType: "message_update",
              payload: expect.objectContaining({
                assistantMessageEvent: expect.objectContaining({ type: "toolcall_end" }),
              }),
            }),
          }),
        ]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("maps Pi terminal response errors into an errored work log and failed turn", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });
      const events: Array<{ readonly type: string; readonly payload: unknown }> = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* adapter.startSession(sessionStart(INSTANCE_A));
      yield* Effect.yieldNow;
      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Call the unavailable model",
        attachments: [],
      });

      yield* runtime.emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "error",
          reason: "error",
          error: { role: "assistant", errorMessage: "Provider rate limit exceeded" },
        },
      });
      yield* runtime.emit({ type: "agent_settled" });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "runtime.error",
            turnId: turn.turnId,
            payload: expect.objectContaining({ message: "Provider rate limit exceeded" }),
          }),
          expect.objectContaining({
            type: "turn.completed",
            turnId: turn.turnId,
            payload: expect.objectContaining({
              state: "failed",
              errorMessage: "Provider rate limit exceeded",
            }),
          }),
        ]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "queues a second Pi prompt through native follow-up behavior while work is active",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntimeFactory();
        const adapter = yield* makePiAdapter(decodePiSettings({}), {
          instanceId: INSTANCE_A,
          sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
          makeRuntime: runtime.factory,
        });
        yield* adapter.startSession(sessionStart(INSTANCE_A));

        const first = yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "First task",
          attachments: [],
        });
        const queued = yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "Follow up after the first task",
          attachments: [],
        });

        expect(queued.turnId).toBe(first.turnId);
        expect(runtime.prompts).toEqual([
          { message: "First task" },
          {
            message: "Follow up after the first task",
            streamingBehavior: "followUp",
          },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("maps Pi queueing, compaction, and retries into visible lifecycle work", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });
      const events: Array<{ readonly type: string; readonly payload: unknown }> = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* adapter.startSession(sessionStart(INSTANCE_A));
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Continue with queued work",
        attachments: [],
      });

      yield* runtime.emit({
        type: "queue_update",
        steering: ["Focus on tests"],
        followUp: ["Summarize afterwards"],
      });
      yield* runtime.emit({ type: "compaction_start", reason: "threshold" });
      yield* runtime.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 500,
        errorMessage: "Temporary overload",
      });
      yield* runtime.emit({ type: "auto_retry_end", success: true, attempt: 1 });
      yield* runtime.emit({
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "Condensed earlier context" },
        aborted: false,
        willRetry: false,
      });
      yield* runtime.emit({ type: "queue_update", steering: [], followUp: [] });
      yield* runtime.emit({ type: "agent_settled" });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "task.progress",
            payload: expect.objectContaining({
              description: "Queued work",
              summary: "1 steering message and 1 follow-up message queued",
            }),
          }),
          expect.objectContaining({
            type: "item.started",
            payload: expect.objectContaining({
              itemType: "context_compaction",
              title: "Compacting conversation",
            }),
          }),
          expect.objectContaining({
            type: "task.started",
            payload: expect.objectContaining({
              taskType: "retry",
              description: "Retrying Pi request",
            }),
          }),
          expect.objectContaining({
            type: "task.completed",
            payload: expect.objectContaining({ status: "completed" }),
          }),
          expect.objectContaining({
            type: "item.completed",
            payload: expect.objectContaining({
              itemType: "context_compaction",
              status: "completed",
              detail: "Condensed earlier context",
            }),
          }),
        ]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("uses Pi's native abort command and marks the active turn interrupted", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });
      const events: Array<{ readonly type: string; readonly payload: unknown }> = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* adapter.startSession(sessionStart(INSTANCE_A));
      yield* Effect.yieldNow;
      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Start a long task",
        attachments: [],
      });

      yield* adapter.interruptTurn(THREAD_ID, turn.turnId);
      yield* runtime.emit({ type: "agent_settled" });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(runtime.getAbortCount()).toBe(1);
      const interruptedTurns = events.filter(
        (event) =>
          event.type === "turn.completed" &&
          event.payload !== null &&
          typeof event.payload === "object" &&
          "state" in event.payload &&
          event.payload.state === "interrupted",
      );
      expect(interruptedTurns).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("delivers persisted image attachments through Pi's native prompt shape", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntimeFactory();
      const loadImageAttachment = vi.fn((attachment: { readonly mimeType: string }) =>
        Effect.succeed({
          type: "image" as const,
          data: "aW1hZ2UtYnl0ZXM=",
          mimeType: attachment.mimeType,
        }),
      );
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        loadImageAttachment,
        makeRuntime: runtime.factory,
      });
      yield* adapter.startSession(sessionStart(INSTANCE_A));

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "What is in this image?",
        attachments: [
          {
            type: "image",
            id: "thread-native-550e8400-e29b-41d4-a716-446655440000",
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 11,
          },
        ],
      });

      expect(loadImageAttachment).toHaveBeenCalledTimes(1);
      expect(runtime.prompts).toEqual([
        {
          message: "What is in this image?",
          images: [
            {
              type: "image",
              data: "aW1hZ2UtYnl0ZXM=",
              mimeType: "image/png",
            },
          ],
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("restarts the same native session only inside its originating runtime instance", () =>
    Effect.gen(function* () {
      const firstRuntime = yield* makeRuntimeFactory();
      const secondRuntime = yield* makeRuntimeFactory();
      const first = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: firstRuntime.factory,
      });
      const second = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_B,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_work",
        makeRuntime: secondRuntime.factory,
      });

      yield* first.startSession(sessionStart(INSTANCE_A));
      yield* first.stopSession(THREAD_ID);
      yield* first.startSession(sessionStart(INSTANCE_A));

      expect(firstRuntime.options.map((entry) => entry.sessionId)).toEqual([
        "thread-native",
        "thread-native",
      ]);
      expect(firstRuntime.options.map((entry) => entry.sessionDirectory)).toEqual([
        "/tmp/t3-pi-sessions/pi_personal",
        "/tmp/t3-pi-sessions/pi_personal",
      ]);
      expect(secondRuntime.options).toEqual([]);
      expect(yield* second.hasSession(THREAD_ID)).toBe(false);
    }).pipe(Effect.scoped),
  );
});
