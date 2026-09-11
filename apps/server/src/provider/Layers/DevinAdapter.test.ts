import * as Schema from "effect/Schema";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  ApprovalRequestId,
  EnvironmentId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as AcpErrors from "effect-acp/errors";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { ServerConfig } from "../../config.ts";
import { makeDevinAdapter } from "./DevinAdapter.ts";
import * as DevinAcpSupport from "../acp/DevinAcpSupport.ts";
import type { AcpSessionRuntimeEvent } from "../acp/AcpSessionRuntime.ts";
import {
  makeDevinCli,
  devinTestLayer as layer,
  decodeDevinLaunch as decodeLaunch,
  encodeDevinSkills,
} from "../testUtils/devinCli.ts";

const threadId = ThreadId.make("devin-thread");
const instanceId = ProviderInstanceId.make("devin-account");
const makeHarness = Effect.fn("makeDevinAdapterHarness")(function* (
  ...args: Parameters<typeof makeDevinCli>
) {
  const cli = yield* makeDevinCli(...args);
  const { settings, environment, root } = cli;
  const adapter = yield* makeDevinAdapter(settings, { instanceId, environment });
  const events: ProviderRuntimeEvent[] = [];
  const approval =
    yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
  yield* Stream.runForEach(adapter.streamEvents, (event) =>
    Effect.gen(function* () {
      events.push(event);
      if (event.type === "request.opened") yield* Deferred.succeed(approval, event);
    }),
  ).pipe(Effect.forkScoped);
  const start = (model = "devin-test-low") =>
    adapter.startSession({
      threadId,
      cwd: root,
      runtimeMode: "approval-required",
      modelSelection: { instanceId, model },
    });
  return { ...cli, adapter, events, approval, start };
});

it.effect("streams a turn and loads the saved ACP session ID without authenticating", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const session = yield* h.start();
    expect(session.providerInstanceId).toBe(instanceId);
    const result = yield* h.adapter.sendTurn({ threadId, input: "Say hello" });
    expect(result.resumeCursor).toEqual(session.resumeCursor);
    yield* h.adapter.stopSession(threadId);
    expect(yield* h.adapter.hasSession(threadId)).toBe(false);
    yield* h.adapter.startSession({
      threadId,
      cwd: h.root,
      runtimeMode: "full-access",
      resumeCursor: session.resumeCursor,
    });
    const requests = yield* h.requests;
    const config = yield* ServerConfig;
    for (const method of ["session/new", "session/load"]) {
      expect(
        requests.find((request) => request.method === method)?.params?.additionalDirectories,
      ).toEqual([config.attachmentsDir]);
    }
    expect(requests.some((request) => request.method === "authenticate")).toBe(false);
    expect(
      requests.some(
        (request) =>
          request.method === "session/load" && request.params?.sessionId === "mock-session-1",
      ),
    ).toBe(true);
    expect(
      requests
        .filter((request) => request.method === "session/set_mode")
        .map((request) => request.params?.modeId),
    ).toEqual(["normal", "normal", "bypass"]);
    expect(
      h.events.some((event) => event.type === "content.delta" && event.payload.delta.length > 0),
    ).toBe(true);
    expect(h.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("connects T3 tools with isolated credentials and restores tool roots on resume", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        McpProviderSession.setMcpProviderSession({
          environmentId: EnvironmentId.make("test-environment"),
          threadId,
          providerSessionId: "test-session",
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:1234/mcp",
          authorizationHeader: "Bearer test-only",
          capabilities: new Set(["preview", "device"]),
          agentDeviceEnvironment: { T3_TEST_DEVICE: "available" },
        }),
      ),
      () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
    );
    const session = yield* h.start();
    const firstDirectory = (yield* h.requests).find((request) => request.method === "session/new")
      ?.params?.additionalDirectories?.[1];
    if (!firstDirectory) throw new Error("Devin must receive its MCP configuration root.");
    yield* h.adapter.stopSession(threadId);
    expect(yield* fs.exists(firstDirectory)).toBe(false);
    yield* h.adapter.startSession({
      threadId,
      cwd: h.root,
      runtimeMode: "approval-required",
      resumeCursor: session.resumeCursor,
    });
    const requests = yield* h.requests;
    for (const method of ["session/new", "session/load"]) {
      const request = requests.find((request) => request.method === method);
      expect(request?.params?.cwd).toBe(h.root);
      expect(request?.params?.additionalDirectories).toHaveLength(2);
      expect(request?.params?.additionalDirectories?.[0]).toBe(config.attachmentsDir);
      expect(
        requests.some(
          (entry) =>
            entry.method === "_cognition.ai/mcp/connectServer" &&
            entry.params?.workspaceDirs?.[0] === request?.params?.additionalDirectories?.[1],
        ),
      ).toBe(true);
    }
    const directory = requests.find((request) => request.method === "session/load")?.params
      ?.additionalDirectories?.[1];
    if (!directory) throw new Error("Resumed Devin sessions must receive fresh MCP configuration.");
    expect(directory).not.toBe(firstDirectory);
    const path = yield* Path.Path;
    const configFile = path.join(directory, ".devin", "mcp_config.local.json");
    const decodeConfig = Schema.decodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          mcpServers: Schema.Struct({
            "t3-code": Schema.Struct({
              serverUrl: Schema.String,
              headers: Schema.Struct({ Authorization: Schema.String }),
            }),
          }),
        }),
      ),
    );
    expect(
      (yield* decodeConfig(yield* fs.readFileString(configFile))).mcpServers["t3-code"],
    ).toEqual({
      serverUrl: "http://127.0.0.1:1234/mcp",
      headers: { Authorization: "Bearer test-only" },
    });
    yield* h.adapter.stopSession(threadId);
    expect(yield* fs.exists(directory)).toBe(false);
    const launches = (yield* fs.readFileString(h.launchLog))
      .trim()
      .split("\n")
      .map((line) => decodeLaunch(line));
    expect(launches.map((launch) => launch.device)).toEqual(["available", "available"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("dispatches a graphical skill pick as a native command with its arguments", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(
      path.join(h.root, "devin-test-skills.json"),
      encodeDevinSkills([
        {
          name: "visual-check",
          description: "Check a browser page.",
          display_name: "Visual check",
          base_dir: path.join(h.root, ".devin", "skills", "visual-check"),
          triggers: ["user"],
          errors: [],
        },
      ]),
    );
    yield* h.start();
    for (const [input, text] of [
      ["$visual-check http://localhost:5173", "/visual-check http://localhost:5173"],
      ["$visual-check", "/visual-check"],
      ["/visual-check", "/visual-check"],
    ]) {
      yield* h.adapter.sendTurn({ threadId, input });
      const request = (yield* h.requests).findLast((entry) => entry.method === "session/prompt");
      expect(request?.params?.prompt).toEqual([{ type: "text", text }]);
    }
    const config = yield* ServerConfig;
    const attachmentId = "devin-thread-11111111-1111-4111-8111-111111111111";
    yield* h.adapter.sendTurn({
      threadId,
      input: "$visual-check",
      attachments: [
        { type: "file", id: attachmentId, name: "page.txt", mimeType: "text/plain", sizeBytes: 1 },
      ],
    });
    const withFile = (yield* h.requests).findLast((entry) => entry.method === "session/prompt");
    expect(withFile?.params?.prompt).toEqual([
      {
        type: "text",
        text: `/visual-check Attached file: ${path.join(config.attachmentsDir, `${attachmentId}.txt`)}`,
      },
    ]);
    expect(
      h.events.some(
        (event) => event.type === "turn.completed" && event.payload.state === "completed",
      ),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("cleans up MCP credentials when the tool server cannot connect", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ T3_ACP_DEVIN_MCP_STATUS: "auth_required" });
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        McpProviderSession.setMcpProviderSession({
          environmentId: EnvironmentId.make("test-environment"),
          threadId,
          providerSessionId: "test-session",
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:1234/mcp",
          authorizationHeader: "Bearer test-only",
          capabilities: new Set(["preview"]),
          agentDeviceEnvironment: {},
        }),
      ),
      () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
    );
    const error = yield* h.start().pipe(Effect.flip);
    expect(error.message).toContain("Devin could not connect to T3 Code tools.");
    expect(yield* h.adapter.hasSession(threadId)).toBe(false);
    const directory = (yield* h.requests).find((request) => request.method === "session/new")
      ?.params?.additionalDirectories?.[1];
    if (!directory) throw new Error("The failed session must have attempted MCP setup.");
    expect(yield* fs.exists(directory)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

for (const operation of ["startSession", "sendTurn"] as const) {
  it.effect(`rejects ${operation} when a disconnect is consumed before returning`, () =>
    Effect.gen(function* () {
      const makeRuntime = DevinAcpSupport.makeDevinAcpRuntime;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(DevinAcpSupport, "makeDevinAcpRuntime").mockImplementation((...args) =>
            Effect.gen(function* () {
              const runtime = yield* makeRuntime(...args);
              const events = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
              const closed = yield* Deferred.make<void>();
              yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
              let drains = 0;
              return {
                ...runtime,
                getEvents: () => Stream.fromQueue(events),
                drainEvents: Effect.gen(function* () {
                  if (++drains === (operation === "startSession" ? 1 : 2)) {
                    yield* Queue.offer(events, {
                      _tag: "ConnectionTerminated",
                      error: new AcpErrors.AcpTransportError({
                        detail: "Devin process disconnected.",
                        cause: undefined,
                      }),
                    });
                  }
                  const acknowledge = yield* Deferred.make<void>();
                  yield* Queue.offer(events, { _tag: "EventStreamBarrier", acknowledge });
                  yield* Effect.raceFirst(Deferred.await(acknowledge), Deferred.await(closed));
                }),
              };
            }),
          ),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const h = yield* makeHarness();
      if (operation === "sendTurn") yield* h.start();
      const error = yield* (
        operation === "startSession"
          ? h.start().pipe(Effect.asVoid)
          : h.adapter.sendTurn({ threadId, input: "Hello" }).pipe(Effect.asVoid)
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ProviderAdapterSessionClosedError",
        provider: "devin",
        threadId,
      });
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
    }).pipe(Effect.provide(layer)),
  );
}

it.effect("applies family thinking choices and enters and leaves plan mode", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.start("devin-test");
    yield* h.adapter.sendTurn({
      threadId,
      input: "Plan it",
      interactionMode: "plan",
      modelSelection: {
        instanceId,
        model: "devin-test",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    yield* h.adapter.sendTurn({ threadId, input: "Implement it", interactionMode: "default" });
    const requests = yield* h.requests;
    expect(
      requests
        .filter(
          (request) =>
            request.method === "session/set_config_option" && request.params?.configId === "model",
        )
        .map((request) => request.params?.value),
    ).toEqual(["devin-test-high"]);
    expect(
      requests
        .filter((request) => request.method === "session/set_mode")
        .map((request) => request.params?.modeId),
    ).toEqual(["normal", "plan", "normal"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("resolves native approval option IDs and streams the completed tool", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      T3_ACP_EMIT_TOOL_CALLS: "1",
      T3_ACP_ALLOW_ONCE_OPTION_ID: "devin:approve:42",
    });
    yield* h.start();
    const turn = yield* h.adapter
      .sendTurn({ threadId, input: "Read metadata" })
      .pipe(Effect.forkScoped);
    const request = yield* Deferred.await(h.approval);
    expect(request.payload.options?.map((option) => option.decision)).toEqual([
      "accept",
      "acceptForSession",
      "decline",
    ]);
    yield* h.adapter.respondToRequest(
      threadId,
      ApprovalRequestId.make(request.requestId ?? "missing-request-id"),
      "accept",
    );
    yield* Fiber.join(turn);
    expect(
      h.events.some(
        (event) => event.type === "request.resolved" && event.payload.decision === "accept",
      ),
    ).toBe(true);
    expect(
      (yield* h.requests).some(
        (request) => request.result?.outcome?.optionId === "devin:approve:42",
      ),
    ).toBe(true);
    expect(
      h.events.some(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      ),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("cancels while waiting for permission and returns the session to ready", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ T3_ACP_EMIT_TOOL_CALLS: "1" });
    yield* h.start();
    const turn = yield* h.adapter
      .sendTurn({ threadId, input: "Read metadata" })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(h.approval);
    yield* h.adapter.interruptTurn(threadId);
    yield* Fiber.join(turn);
    expect(
      h.events.some(
        (event) => event.type === "turn.completed" && event.payload.state === "cancelled",
      ),
    ).toBe(true);
    expect((yield* h.adapter.listSessions())[0]?.status).toBe("ready");
  }).pipe(Effect.provide(layer)),
);

it.effect("switches between explicit models and maps ACP usage updates", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ T3_ACP_DEVIN: "1" });
    yield* h.start("devin-test-high");
    yield* h.adapter.sendTurn({
      threadId,
      input: "Use the low variant",
      modelSelection: { instanceId, model: "devin-test-low" },
    });
    expect((yield* h.adapter.listSessions())[0]?.model).toBe("devin-test-low");
    expect(h.events.find((event) => event.type === "thread.token-usage.updated")?.payload).toEqual({
      usage: { usedTokens: 1800, maxTokens: 200000 },
    });
    expect(
      (yield* h.requests)
        .filter((request) => request.method === "session/set_config_option")
        .map((request) => request.params?.value),
    ).toEqual(["devin-test-high", "devin-test-low"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("reports prompt failures and refuses a model from another instance", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ T3_ACP_FAIL_PROMPT: "1" });
    yield* h.start();
    const other = yield* h.adapter
      .sendTurn({
        threadId,
        input: "No",
        modelSelection: {
          instanceId: ProviderInstanceId.make("another-account"),
          model: "default",
        },
      })
      .pipe(Effect.result);
    expect(other._tag).toBe("Failure");
    const failed = yield* h.adapter.sendTurn({ threadId, input: "Fail" }).pipe(Effect.result);
    expect(failed._tag).toBe("Failure");
    expect(
      h.events.some((event) => event.type === "turn.completed" && event.payload.state === "failed"),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("settles a steered turn when the replacement model is unavailable", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ T3_ACP_EMIT_TOOL_CALLS: "1" });
    yield* h.start();
    const first = yield* h.adapter
      .sendTurn({ threadId, input: "Read metadata" })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(h.approval);
    const replacement = yield* h.adapter
      .sendTurn({
        threadId,
        input: "Use another model",
        modelSelection: { instanceId, model: "unavailable-model" },
      })
      .pipe(Effect.result);
    expect(replacement._tag).toBe("Failure");
    yield* Fiber.join(first);
    expect((yield* h.adapter.listSessions())[0]?.activeTurnId).toBeUndefined();
    expect(h.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(
      h.events.some((event) => event.type === "turn.completed" && event.payload.state === "failed"),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("stopping one adapter leaves another adapter session running", () =>
  Effect.gen(function* () {
    const first = yield* makeHarness();
    const second = yield* makeHarness();
    yield* first.start();
    yield* second.start();
    yield* first.adapter.stopAll();
    expect(yield* first.adapter.hasSession(threadId)).toBe(false);
    expect(yield* second.adapter.hasSession(threadId)).toBe(true);
    yield* second.adapter.sendTurn({ threadId, input: "Still here" });
    expect((yield* second.adapter.listSessions())[0]?.status).toBe("ready");
  }).pipe(Effect.provide(layer)),
);

it.effect("stopping an active session settles its turn before reopening the thread", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ T3_ACP_EMIT_TOOL_CALLS: "1" });
    yield* h.start();
    const turn = yield* h.adapter
      .sendTurn({ threadId, input: "Read metadata" })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(h.approval);
    yield* h.adapter.stopSession(threadId);
    yield* Fiber.await(turn);
    expect(yield* h.adapter.hasSession(threadId)).toBe(false);
    yield* h.start();
    expect((yield* h.adapter.listSessions())[0]?.status).toBe("ready");
    expect(h.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("Stop waits for a steering launch and cancels its replacement prompt", () =>
  Effect.gen(function* () {
    const cli = yield* makeDevinCli({ T3_ACP_WAIT_FOR_CANCEL: "1" });
    const modeHeld = yield* Deferred.make<void>();
    const releaseMode = yield* Deferred.make<void>();
    const firstPrompt = yield* Deferred.make<void>();
    const secondPrompt = yield* Deferred.make<void>();
    const isRequestLog = Schema.is(
      Schema.Struct({
        event: Schema.Struct({
          kind: Schema.Literal("request"),
          payload: Schema.Struct({ method: Schema.String, status: Schema.String }),
        }),
      }),
    );
    let modeCount = 0;
    let promptCount = 0;
    const adapter = yield* makeDevinAdapter(cli.settings, {
      instanceId,
      environment: cli.environment,
      nativeEventLogger: {
        filePath: cli.requestLog,
        close: () => Effect.void,
        write: (event) =>
          Effect.gen(function* () {
            if (!isRequestLog(event) || event.event.payload.status !== "started") return;
            const { method } = event.event.payload;
            if (method === "session/set_mode" && ++modeCount === 3) {
              yield* Deferred.succeed(modeHeld, undefined);
              yield* Deferred.await(releaseMode);
            }
            if (method === "session/prompt") {
              if (++promptCount === 2) yield* Deferred.succeed(secondPrompt, undefined);
            }
          }),
      },
    });
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      event.type === "thread.token-usage.updated"
        ? Deferred.succeed(firstPrompt, undefined)
        : Effect.void,
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* adapter.startSession({
      threadId,
      cwd: cli.root,
      runtimeMode: "approval-required",
      modelSelection: { instanceId, model: "devin-test-low" },
    });
    const first = yield* adapter.sendTurn({ threadId, input: "First" }).pipe(Effect.forkScoped);
    yield* Deferred.await(firstPrompt);
    const replacement = yield* adapter
      .sendTurn({ threadId, input: "Steer" })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(modeHeld);
    const stop = yield* adapter
      .interruptTurn(threadId)
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(releaseMode, undefined);
    yield* Deferred.await(secondPrompt);
    yield* Fiber.join(stop);
    const methods = (yield* cli.requests)
      .map((request) => request.method)
      .filter((method) => method === "session/prompt" || method === "session/cancel");
    expect(methods).toEqual([
      "session/prompt",
      "session/cancel",
      "session/prompt",
      "session/cancel",
    ]);
    yield* Fiber.join(first);
    yield* Fiber.join(replacement);
    expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
  }).pipe(Effect.provide(layer)),
);
