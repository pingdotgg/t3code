// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
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
  it.effect.each(["session/new", "session/resume"] as const)(
    "buffers root metadata while %s startup is still pending",
    (setupMethod) =>
      Effect.gen(function* () {
        const setupReplied = yield* Deferred.make<void>();
        const allowStartup = yield* Deferred.make<void>();
        const events: Array<AcpSessionRuntime.AcpSessionRuntimeEvent> = [];
        const runtime = yield* AcpSessionRuntime.make({
          ...mockRuntimeOptions,
          ...(setupMethod === "session/resume"
            ? {
                spawn: {
                  ...mockRuntimeOptions.spawn,
                  env: { T3_ACP_SESSION_LIFECYCLE: "1" },
                },
                resumeSessionId: "mock-session-1",
                resumeMethod: "resume" as const,
              }
            : {}),
          requestLogger: (event) =>
            event.method === setupMethod && event.status === "succeeded"
              ? Deferred.succeed(setupReplied, undefined).pipe(
                  Effect.andThen(Deferred.await(allowStartup)),
                )
              : Effect.void,
        });
        yield* runtime.getEvents().pipe(
          Stream.runForEach((event) => {
            if (event._tag === "EventStreamBarrier") {
              return Deferred.succeed(event.acknowledge, undefined);
            }
            events.push(event);
            return Effect.void;
          }),
          Effect.forkChild,
        );
        const startup = yield* runtime.start().pipe(Effect.forkChild);
        yield* Deferred.await(setupReplied);
        yield* runtime.request("_test/startup-metadata", {});
        yield* Deferred.succeed(allowStartup, undefined);
        yield* Fiber.join(startup);
        yield* runtime.drainEvents;

        expect(events.map((event) => event._tag)).toEqual([
          "AvailableCommandsUpdated",
          "ModeChanged",
          "ConfigOptionsUpdated",
        ]);
        expect(events[0]).toMatchObject({
          availableCommands: [{ name: "plan", description: "Native command" }],
        });
        expect(yield* runtime.getModeState).toMatchObject({ currentModeId: "code" });
        expect(events[2]).toMatchObject({
          configOptions: yield* runtime.getConfigOptions,
        });
        expect(
          (yield* runtime.getConfigOptions).find((option) => option.category === "model"),
        ).toMatchObject({ currentValue: "gpt-5.4" });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("publishes model changes returned by a config request and live notifications", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.make(mockRuntimeOptions);
      yield* runtime.start();
      const updates = yield* Stream.toPull(
        runtime.getEvents().pipe(Stream.filter((event) => event._tag === "ConfigOptionsUpdated")),
      );
      const selected = yield* runtime.setConfigOption("model", "composer-2");
      expect((yield* updates)[0]?.configOptions).toEqual(selected.configOptions);
      yield* runtime.request("_test/startup-metadata", {});
      expect((yield* updates)[0]?.configOptions).toEqual(yield* runtime.getConfigOptions);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("waits for native cancellation and drains final updates before another prompt", () =>
    Effect.gen(function* () {
      const toolStarted = yield* Deferred.make<void>();
      const cancelReceived = yield* Deferred.make<void>();
      const events: Array<AcpSessionRuntime.AcpSessionRuntimeEvent> = [];
      let promptRequests = 0;
      const runtime = yield* AcpSessionRuntime.make({
        ...mockRuntimeOptions,
        spawn: {
          ...mockRuntimeOptions.spawn,
          env: { T3_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL: "1" },
        },
        cancelBehavior: "wait-for-prompt",
        requestLogger: (event) =>
          Effect.sync(() => {
            if (event.method === "session/prompt" && event.status === "started")
              promptRequests += 1;
          }),
      });
      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) => {
          if (event._tag === "EventStreamBarrier") {
            return Deferred.succeed(event.acknowledge, undefined);
          }
          events.push(event);
          if (event._tag === "ToolCallUpdated" && event.toolCall.status === "inProgress") {
            return Deferred.succeed(toolStarted, undefined);
          }
          if (event._tag === "ThoughtDelta" && event.text === "native-cancel-received") {
            return Deferred.succeed(cancelReceived, undefined);
          }
          return Effect.void;
        }),
        Effect.forkChild,
      );
      yield* runtime.start();
      const prompt = yield* runtime
        .prompt({
          prompt: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(toolStarted);
      const cancellation = yield* runtime.cancel.pipe(Effect.forkChild);
      yield* Deferred.await(cancelReceived);
      const replacement = yield* runtime
        .prompt({
          prompt: [{ type: "text", text: "second" }],
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      expect(prompt.pollUnsafe()).toBeUndefined();
      expect(cancellation.pollUnsafe()).toBeUndefined();
      expect(promptRequests).toBe(1);
      yield* runtime.request("_test/finish-cancel", {});
      yield* Fiber.join(cancellation);

      expect(yield* Fiber.join(prompt)).toEqual({
        stopReason: "cancelled",
        _meta: { nativeCancel: true },
      });
      expect(
        events.some(
          (event) =>
            event._tag === "ToolCallUpdated" &&
            event.toolCall.status === "failed" &&
            event.toolCall.detail === "Cancelled.",
        ),
      ).toBe(true);
      const cancelledDelta = events.find(
        (event) => event._tag === "ContentDelta" && event.text === "Request cancelled.",
      );
      expect(cancelledDelta?._tag).toBe("ContentDelta");
      if (cancelledDelta?._tag === "ContentDelta") {
        expect(
          events.filter(
            (event) =>
              event._tag === "AssistantItemCompleted" && event.itemId === cancelledDelta.itemId,
          ),
        ).toHaveLength(1);
      }
      expect(yield* Fiber.join(replacement)).toMatchObject({ stopReason: "end_turn" });
      expect(promptRequests).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an idle child exit and rejects later prompts", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.make(mockRuntimeOptions);
      yield* runtime.start();
      yield* runtime.notify("_test/exit", {});
      const events = yield* runtime.getEvents().pipe(Stream.take(1), Stream.runCollect);
      const event = events[0];
      expect(event).toMatchObject({ _tag: "ConnectionTerminated", error: { code: 19 } });
      if (event?._tag !== "ConnectionTerminated") return;
      expect(
        yield* runtime
          .prompt({
            prompt: [{ type: "text", text: "must not run" }],
          })
          .pipe(Effect.flip),
      ).toBe(event.error);
      expect(yield* runtime.start().pipe(Effect.flip)).toBe(event.error);
      expect(yield* runtime.initialize().pipe(Effect.flip)).toBe(event.error);
      expect(
        yield* runtime.request("_test/environment", {}).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => undefined,
          }),
        ),
      ).toBe(event.error);
      expect(yield* runtime.notify("_test/exit", {}).pipe(Effect.flip)).toBe(event.error);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retires a native runtime when its prompt caller is interrupted", () =>
    Effect.gen(function* () {
      const dispatched = yield* Deferred.make<void>();
      const runtime = yield* AcpSessionRuntime.make({
        ...mockRuntimeOptions,
        spawn: {
          ...mockRuntimeOptions.spawn,
          env: { T3_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL: "1" },
        },
        cancelBehavior: "wait-for-prompt",
      });
      yield* runtime.start();
      const prompt = yield* runtime
        .prompt(
          {
            prompt: [{ type: "text", text: "first" }],
          },
          { dispatched },
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(dispatched);
      yield* Fiber.interrupt(prompt);
      const events = yield* runtime.getEvents().pipe(
        Stream.filter((event) => event._tag === "ConnectionTerminated"),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(events[0]).toMatchObject({
        error: { _tag: "AcpTransportError", method: "session/prompt" },
      });
      expect(
        yield* runtime
          .prompt({
            prompt: [{ type: "text", text: "must not run" }],
          })
          .pipe(Effect.flip),
      ).toBe(events[0]?.error);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails a pending request when the stderr handler rejects the runtime", () =>
    Effect.gen(function* () {
      const failure = new EffectAcpErrors.AcpTransportError({
        detail: "Sign in before continuing.",
        cause: undefined,
      });
      const runtime = yield* AcpSessionRuntime.make({
        ...mockRuntimeOptions,
        spawn: { ...mockRuntimeOptions.spawn, env: { T3_ACP_FLOOD_STDERR: "1" } },
        onStderr: () => Effect.fail(failure),
      });
      expect(yield* runtime.start().pipe(Effect.flip)).toBe(failure);
      const events = yield* runtime.getEvents().pipe(
        Stream.filter((event) => event._tag === "ConnectionTerminated"),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(events[0]?.error).toBe(failure);
      expect(yield* runtime.initialize().pipe(Effect.flip)).toBe(failure);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { name: "exit code", terminate: "process.exit(1)", code: 1, signal: undefined },
    ...(HostProcess.Platform.defaultValue() === "win32"
      ? []
      : [
          {
            name: "signal",
            terminate: "process.kill(process.pid, 'SIGTERM')",
            code: undefined,
            signal: "SIGTERM",
          },
        ]),
  ])("retains the $name and sanitized stderr when ACP exits before initialize", (testCase) =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.make({
        ...mockRuntimeOptions,
        spawn: {
          command: process.execPath,
          args: [
            "-e",
            `process.stderr.write("Invalid project config: Unrecognized key in cli.json\\nAuthorization: Bearer secret-token-value\\n", () => { ${testCase.terminate}; });`,
          ],
        },
      });
      const error = yield* runtime.start().pipe(Effect.flip);
      assert.instanceOf(error, EffectAcpErrors.AcpProcessExitedError);
      expect(error.code).toBe(testCase.code);
      expect(error.signal).toBe(testCase.signal);
      expect(error).toMatchObject({
        pid: expect.any(Number),
        stderr:
          "Invalid project config: Unrecognized key in cli.json\nAuthorization: Bearer [redacted]",
      });
      expect(error.message).toBe(
        `${testCase.signal ? "ACP process exited after signal SIGTERM" : "ACP process exited with code 1"}\nInvalid project config: Unrecognized key in cli.json\nAuthorization: Bearer [redacted]`,
      );
      if (testCase.signal) {
        expect(error.cause).toMatchObject({
          reason: {
            module: "ChildProcess",
            method: "exitCode",
            cause: new Error("Process interrupted due to receipt of signal: 'SIGTERM'"),
          },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("drains large stderr output and keeps auth-sized logging chunks", () =>
    Effect.gen(function* () {
      const lengths: Array<number> = [];
      for (const logStderr of [false, true]) {
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.make({
            ...mockRuntimeOptions,
            spawn: { ...mockRuntimeOptions.spawn, env: { T3_ACP_FLOOD_STDERR: "1" } },
            ...(logStderr
              ? {
                  onStderr: (text: string) =>
                    Effect.sync(() => {
                      lengths.push(text.length);
                    }),
                }
              : {}),
          });
          expect(yield* runtime.initialize()).toMatchObject({ protocolVersion: 2 });
        }).pipe(Effect.scoped);
      }
      expect(lengths.length).toBeGreaterThan(0);
      expect(Math.max(...lengths)).toBeGreaterThanOrEqual(16_384);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(32_768);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("releases a queued event drain when its runtime scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const barrierReceived = yield* Deferred.make<void>();
      const runtime = yield* AcpSessionRuntime.make(mockRuntimeOptions).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      yield* runtime.start();
      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) =>
          event._tag === "EventStreamBarrier"
            ? Deferred.succeed(barrierReceived, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        ),
        Effect.forkIn(scope),
      );
      const drain = yield* runtime.drainEvents.pipe(Effect.forkChild);
      yield* Deferred.await(barrierReceived);
      yield* Scope.close(scope, Exit.void);
      yield* Fiber.join(drain);
      yield* runtime.drainEvents;
      expect(yield* runtime.initialize().pipe(Effect.flip)).toMatchObject({
        _tag: "AcpTransportError",
        detail: "The ACP session runtime is closed.",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not restore ambient variables to a sanitized child environment", () =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.T3_ACP_RUNTIME_AMBIENT;
          process.env.T3_ACP_RUNTIME_AMBIENT = "sentinel";
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.T3_ACP_RUNTIME_AMBIENT;
            else process.env.T3_ACP_RUNTIME_AMBIENT = previous;
          }),
      );
      const runtime = yield* AcpSessionRuntime.make({
        ...mockRuntimeOptions,
        spawn: {
          command: process.execPath,
          args: mockAgentArgs,
          extendEnv: false,
          env: { T3_ACP_RUNTIME_EXPLICIT: "kept" },
        },
      });
      yield* runtime.initialize();
      expect(yield* runtime.request("_test/environment", {})).toEqual({
        inherited: false,
        explicit: true,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("selects explicit or agent-managed authentication without choosing terminal auth", () => {
    const methods = [
      { id: "browser", name: "Browser", type: "terminal" as const },
      { id: "api-key", name: "API key", type: "agent" as const },
    ];

    expect(AcpSessionRuntime.selectAcpAgentAuthMethod(methods)?.id).toBe("api-key");
    expect(AcpSessionRuntime.selectAcpAgentAuthMethod(methods, "browser")?.id).toBe("browser");
    expect(AcpSessionRuntime.selectAcpAgentAuthMethod(methods, "missing")).toBeUndefined();
  });

  it.effect("prefers MCP-over-ACP only when the agent advertises that transport", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const created = requestEvents.find(
        (event) => event.method === "session/new" && event.status === "started",
      );
      expect(created?.payload).toMatchObject({
        mcpServers: [{ type: "acp", name: "t3-code", serverId: "t3-code" }],
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { T3_ACP_MCP_ACP: "1" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          authMethodId: "test",
          mcpServers: [{ type: "stdio", name: "t3-code", command: "/usr/bin/node", args: [] }],
          acpMcpServers: [{ type: "acp", name: "t3-code", serverId: "t3-code" }],
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("supports v2 session deletion and secret-safe provider management", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.deleteSession("native-session-1");
      expect((yield* runtime.listProviders).providers[0]).toMatchObject({
        providerId: "mock-provider",
        current: null,
      });
      yield* runtime.setProvider({
        providerId: "mock-provider",
        apiType: "openai",
        baseUrl: "https://api.example.test/v1",
        headers: { Authorization: "Bearer top-secret" },
      });
      expect((yield* runtime.listProviders).providers[0]?.current).toEqual({
        apiType: "openai",
        baseUrl: "https://api.example.test/v1",
      });
      yield* runtime.disableProvider("mock-provider");
      expect((yield* runtime.listProviders).providers[0]?.current).toBeNull();

      const setRequest = requestEvents.find(
        (event) => event.method === "providers/set" && event.status === "started",
      );
      expect(setRequest?.payload).toMatchObject({
        headers: { Authorization: "[redacted]" },
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { T3_ACP_V2_MANAGEMENT: "1" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("authenticates explicitly typed v2 agent methods and retries session creation", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.sessionId).toBe("mock-session-1");
      expect(
        requestEvents.filter((event) => event.status === "started").map((event) => event.method),
      ).toEqual(["initialize", "session/new", "authenticate", "session/new"]);
      expect(
        requestEvents.filter(
          (event) => event.method === "session/new" && event.status === "failed",
        ),
      ).toHaveLength(1);
      expect(
        requestEvents.filter(
          (event) => event.method === "session/new" && event.status === "succeeded",
        ),
      ).toHaveLength(1);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              T3_ACP_AUTH_METHOD_ID: "test",
              T3_ACP_REQUIRE_AUTH: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("can surface auth-required without authenticating during discovery", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    let advertisedAuthMethodName: string | undefined;
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const result = yield* Effect.result(runtime.start());

      expect(Result.isFailure(result)).toBe(true);
      expect(advertisedAuthMethodName).toBe("Mock agent authentication");
      expect(
        requestEvents.filter((event) => event.status === "started").map((event) => event.method),
      ).toEqual(["initialize", "session/new"]);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authenticateOnAuthRequired: false,
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              T3_ACP_AUTH_METHOD_ID: "test",
              T3_ACP_REQUIRE_AUTH: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          onInitialized: (initializeResult) =>
            Effect.sync(() => {
              advertisedAuthMethodName = initializeResult.authMethods?.[0]?.name;
            }),
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

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
      Effect.provide(NodeServices.layer),
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
    }).pipe(Effect.provide(NodeServices.layer));
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
      Effect.provide(NodeServices.layer),
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
      Effect.provide(NodeServices.layer),
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
      Effect.provide(NodeServices.layer),
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
      Effect.provide(NodeServices.layer),
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
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
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
      Effect.provide(NodeServices.layer),
    ),
  );

  // regression: #3156 harden ACP resume with replay-idle load readiness
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
      Effect.provide(NodeServices.layer),
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
      Effect.provide(NodeServices.layer),
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
      Effect.provide(NodeServices.layer),
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
      Effect.provide(NodeServices.layer),
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
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });
});
