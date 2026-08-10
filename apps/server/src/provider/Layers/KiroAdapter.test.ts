// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  KiroSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  kiroPromptSettlementBelongsToContext,
  makeKiroAdapter,
  parseKiroResume,
} from "./KiroAdapter.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

const KIRO_PROVIDER = ProviderDriverKind.make("kiro");
const KIRO_INSTANCE = ProviderInstanceId.make("kiro");

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

/**
 * Stand-in for `kiro-cli acp`. Defaults mirror kiro-cli 2.16.2: `authenticate`
 * is not implemented, permission option ids are snake_case, and the model
 * catalog uses Kiro's dotted ids.
 */
async function makeMockKiroWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-kiro-cli.sh");
  const env: Record<string, string> = {
    T3_ACP_FAIL_AUTHENTICATE: "1",
    T3_ACP_ALLOW_ONCE_OPTION_ID: "allow_once",
    T3_ACP_ALLOW_ALWAYS_OPTION_ID: "allow_always",
    T3_ACP_REJECT_ONCE_OPTION_ID: "reject_once",
    T3_ACP_MODEL_IDS: "auto,claude-haiku-4.5",
    ...extraEnv,
  };
  const envExports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readArgsLog(filePath: string): Promise<ReadonlyArray<string>> {
  const raw = await NodeFSP.readFile(filePath, "utf8").catch(() => "");
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

/** JSON-RPC methods the mock agent received, in order. */
async function readRequestMethods(filePath: string): Promise<ReadonlyArray<string>> {
  const raw = await NodeFSP.readFile(filePath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === "object" &&
        parsed !== null &&
        "method" in parsed &&
        typeof (parsed as { method: unknown }).method === "string"
        ? [(parsed as { method: string }).method]
        : [];
    });
}

/** Permission outcomes the adapter sent back, read from the mock's request log. */
async function readPermissionOutcomes(filePath: string): Promise<ReadonlyArray<unknown>> {
  const raw = await NodeFSP.readFile(filePath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      return parsed;
    })
    .filter(
      (message): message is { readonly result: { readonly outcome: unknown } } =>
        typeof message === "object" &&
        message !== null &&
        "result" in message &&
        typeof (message as { result: unknown }).result === "object" &&
        (message as { result: Record<string, unknown> }).result !== null &&
        "outcome" in (message as { result: Record<string, unknown> }).result,
    )
    .map((message) => message.result.outcome);
}

const kiroAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kiro-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeKiroAdapter>[1]) =>
  makeKiroAdapter(decodeKiroSettings({ enabled: true, binaryPath }), options).pipe(Effect.orDie);

it("only settles a prompt against the live Kiro turn", () => {
  const staleTurnId = "stale-turn" as never;
  const replacementTurnId = "replacement-turn" as never;

  assert.isFalse(
    kiroPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isFalse(
    kiroPromptSettlementBelongsToContext({
      liveAcpSessionId: "replacement-session",
      expectedAcpSessionId: "stale-session",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    kiroPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it("accepts only its own resume cursor version", () => {
  assert.deepStrictEqual(parseKiroResume({ schemaVersion: 1, sessionId: "session-1" }), {
    sessionId: "session-1",
  });
  assert.isUndefined(parseKiroResume({ schemaVersion: 2, sessionId: "session-1" }));
  assert.isUndefined(parseKiroResume({ sessionId: "session-1" }));
  assert.isUndefined(parseKiroResume({ schemaVersion: 1, sessionId: "   " }));
  assert.isUndefined(parseKiroResume(undefined));
  assert.isUndefined(parseKiroResume("session-1"));
});

it.layer(kiroAdapterTestLayer)("KiroAdapter", (it) => {
  it.effect("starts a session without authenticating and streams a turn to completion", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-mock-thread");
      // The wrapper answers `authenticate` with -32601 like the real CLI, so
      // reaching a started session proves the auth step is skipped.
      const wrapperPath = yield* Effect.promise(() => makeMockKiroWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "kiro");
      assert.equal(session.providerInstanceId, "kiro");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({ threadId, input: "hello kiro", attachments: [] });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      assert.includeMembers(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.state.changed",
          "thread.started",
          "turn.started",
          "content.delta",
          "turn.completed",
        ] as const,
      );

      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
        assert.equal(delta.payload.streamKind, "assistant_text");
      }

      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "completed");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("publishes Kiro reasoning on the reasoning stream, not as assistant text", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-thought-chunks");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_THOUGHT_CHUNKS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const deltas: Array<{ readonly streamKind: string; readonly delta: string }> = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          if (event.type === "content.delta") {
            deltas.push({
              streamKind: event.payload.streamKind ?? "assistant_text",
              delta: event.payload.delta,
            });
          }
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "think about it", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);

      assert.deepStrictEqual(
        deltas.find((delta) => delta.streamKind === "reasoning_text"),
        { streamKind: "reasoning_text", delta: "weighing the options" },
      );
      assert.deepStrictEqual(
        deltas.find((delta) => delta.streamKind === "assistant_text"),
        { streamKind: "assistant_text", delta: "hello from mock" },
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("launches the ACP subcommand and honours the configured agent", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-launch-args");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-adapter-args-")),
      );
      const argsLogPath = NodePath.join(tempDir, "args.log");
      const wrapperDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-args-wrapper-")),
      );
      const wrapperPath = NodePath.join(wrapperDir, "fake-kiro-cli.sh");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          wrapperPath,
          [
            "#!/bin/sh",
            // @effect-diagnostics-next-line preferSchemaOverJson:off - shell-quotes a path in fake CLI source.
            `printf '%s\\n' "$*" >> ${JSON.stringify(argsLogPath)}`,
            'export T3_ACP_FAIL_AUTHENTICATE="1"',
            // @effect-diagnostics-next-line preferSchemaOverJson:off - shell-quotes a path in fake CLI source.
            `exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"`,
            "",
          ].join("\n"),
          "utf8",
        ),
      );
      yield* Effect.promise(() => NodeFSP.chmod(wrapperPath, 0o755));

      const adapter = yield* makeKiroAdapter(
        decodeKiroSettings({ enabled: true, binaryPath: wrapperPath, agent: "kiro_planner" }),
      ).pipe(Effect.orDie);

      yield* adapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const loggedArgs = yield* Effect.promise(() => readArgsLog(argsLogPath));
      assert.deepStrictEqual(loggedArgs, ["acp --agent kiro_planner"]);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("switches models in-session using Kiro's dotted model ids", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-model-switch");
      const wrapperPath = yield* Effect.promise(() => makeMockKiroWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const session = yield* adapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: KIRO_INSTANCE, model: "claude-haiku-4.5" },
      });

      assert.equal(session.model, "claude-haiku-4.5");
      assert.equal(adapter.capabilities.sessionModelSwitch, "in-session");

      // Aliases resolve to Kiro's own spelling before reaching the CLI.
      yield* adapter.sendTurn({
        threadId,
        input: "switch me",
        attachments: [],
        modelSelection: { instanceId: KIRO_INSTANCE, model: "claude-haiku-4-5" },
      });

      const sessions = yield* adapter.listSessions();
      assert.equal(
        sessions.find((entry) => entry.threadId === threadId)?.model,
        "claude-haiku-4.5",
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps a Kiro tool call and its snake_case permission options", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-tool-call");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "request.opened"
              ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
              : event.type === "turn.completed"
                ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore)
                : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "run a command", attachments: [] })
        .pipe(Effect.forkChild);

      const opened = yield* Deferred.await(requestOpened);
      const running = yield* adapter.listSessions();
      assert.equal(running.find((entry) => entry.threadId === threadId)?.status, "running");

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "accept",
      );
      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);

      const types = runtimeEvents.map((event) => event.type);
      assert.includeMembers(types, ["request.opened", "request.resolved", "turn.completed"]);

      // Tool calls surface as runtime items, keyed by the ACP tool call id.
      const toolItem = runtimeEvents.find(
        (event) =>
          (event.type === "item.updated" || event.type === "item.completed") &&
          event.itemId === "tool-call-1",
      );
      assert.isDefined(toolItem, `expected a tool item event, saw ${types.join(", ")}`);
      if (toolItem?.type === "item.updated" || toolItem?.type === "item.completed") {
        assert.equal(toolItem.payload.itemType, "command_execution");
      }

      const ready = yield* adapter.listSessions();
      assert.equal(ready.find((entry) => entry.threadId === threadId)?.status, "ready");
      assert.isUndefined(ready.find((entry) => entry.threadId === threadId)?.activeTurnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancels the pending approval and the turn when interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-interrupt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const turnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
          : event.type === "turn.completed"
            ? Deferred.succeed(turnCompleted, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "long running work", attachments: [] })
        .pipe(Effect.forkChild);

      yield* Deferred.await(requestOpened);
      yield* adapter.interruptTurn(threadId);

      const completed = yield* Deferred.await(turnCompleted);
      assert.equal(completed.payload.state, "cancelled");

      yield* Fiber.join(sendTurnFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(eventsFiber);

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("auto-approves permission requests in full-access mode", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-full-access");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      // No respondToRequest: the turn can only finish if the adapter selected
      // an allow option itself from the advertised kinds.
      yield* adapter.sendTurn({ threadId, input: "just do it", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);

      assert.isFalse(runtimeEvents.some((event) => event.type === "request.opened"));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("settles pending approvals when the session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-stop-settles-approvals");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "needs approval", attachments: [] })
        .pipe(Effect.forkChild);

      yield* Deferred.await(requestOpened);
      yield* adapter.stopSession(threadId);

      // The waiting approval must resolve rather than hang the fiber forever.
      yield* Fiber.join(sendTurnFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(eventsFiber);

      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("sends Kiro's own option ids for each approval decision", () =>
    Effect.gen(function* () {
      const decisions = [
        { decision: "accept" as const, expectedOptionId: "allow_once" },
        { decision: "acceptForSession" as const, expectedOptionId: "allow_always" },
        { decision: "decline" as const, expectedOptionId: "reject_once" },
      ];

      for (const { decision, expectedOptionId } of decisions) {
        const threadId = ThreadId.make(`kiro-decision-${decision}`);
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-decision-log-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.log");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockKiroWrapper({
            T3_ACP_EMIT_TOOL_CALLS: "1",
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const requestOpened =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          event.type === "request.opened"
            ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
            : Effect.void,
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: KIRO_PROVIDER,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const sendTurnFiber = yield* adapter
          .sendTurn({ threadId, input: `decide: ${decision}`, attachments: [] })
          .pipe(Effect.forkChild);

        const opened = yield* Deferred.await(requestOpened);
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(String(opened.requestId)),
          decision,
        );
        yield* Fiber.join(sendTurnFiber);
        yield* Fiber.interrupt(eventsFiber);

        const outcomes = yield* Effect.promise(() => readPermissionOutcomes(requestLogPath));
        assert.deepStrictEqual(
          outcomes,
          [{ outcome: "selected", optionId: expectedOptionId }],
          `unexpected outcome for ${decision}`,
        );

        yield* adapter.stopSession(threadId);
      }
    }),
  );

  it.effect("reports that Kiro never asks for structured user input", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-user-input");
      const wrapperPath = yield* Effect.promise(() => makeMockKiroWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(
        adapter.respondToUserInput(threadId, ApprovalRequestId.make("no-such-request"), {}),
      );
      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag === "ProviderAdapterRequestError") {
        assert.include(error.detail, "does not request structured user input");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps asking for approval in every runtime mode short of full access", () =>
    Effect.gen(function* () {
      // Kiro exposes no "routine vs risky" split over ACP, so `auto` and
      // `auto-accept-edits` must behave like Supervised rather than silently
      // granting permission.
      for (const runtimeMode of ["approval-required", "auto", "auto-accept-edits"] as const) {
        const threadId = ThreadId.make(`kiro-mode-${runtimeMode}`);
        const wrapperPath = yield* Effect.promise(() =>
          makeMockKiroWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const requestOpened =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          event.type === "request.opened"
            ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
            : Effect.void,
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: KIRO_PROVIDER,
          cwd: process.cwd(),
          runtimeMode,
        });
        const sendTurnFiber = yield* adapter
          .sendTurn({ threadId, input: "needs a decision", attachments: [] })
          .pipe(Effect.forkChild);

        const opened = yield* Deferred.await(requestOpened);
        assert.isDefined(opened.requestId, `${runtimeMode} should raise an approval request`);

        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(String(opened.requestId)),
          "accept",
        );
        yield* Fiber.join(sendTurnFiber);
        yield* Fiber.interrupt(eventsFiber);
        yield* adapter.stopSession(threadId);
      }
    }),
  );

  it.effect("publishes Kiro's todo list as a plan, without repeating an unchanged one", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-todo-plan");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_KIRO_TODOS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const planUpdates: Array<unknown> = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          if (event.type === "turn.plan.updated") {
            planUpdates.push(event.payload);
          }
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "plan the work", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);

      // The mock also sends a standard ACP `plan` update, which Kiro itself
      // never does but the adapter still forwards. After that, three todo
      // notifications arrive, two of them identical, so only the announcement
      // and the completion state should be published.
      assert.deepStrictEqual(planUpdates, [
        {
          plan: [
            { step: "Inspect mock ACP state", status: "completed" },
            { step: "Implement the requested change", status: "inProgress" },
          ],
        },
        {
          explanation: "mock plan",
          plan: [
            { step: "step one", status: "pending" },
            { step: "step two", status: "pending" },
          ],
        },
        {
          explanation: "mock plan",
          plan: [
            { step: "step one", status: "completed" },
            { step: "step two", status: "pending" },
          ],
        },
      ]);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes an existing Kiro session instead of creating a new one", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-resume");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-resume-log-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_LOAD_REPLAY: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const deltas: Array<string> = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          if (event.type === "content.delta") {
            deltas.push(event.payload.delta);
          }
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      const methods = yield* Effect.promise(() => readRequestMethods(requestLogPath));
      assert.include(methods, "session/load");
      assert.notInclude(methods, "session/new");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      // Replayed history must not reappear as fresh assistant output. The mock
      // replays both a marked (`_meta.isReplay`) and an unmarked chunk, which
      // is what kiro-cli itself does before answering session/load.
      assert.notInclude(deltas.join(""), "replayed assistant text");

      yield* adapter.sendTurn({ threadId, input: "continue please", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);

      assert.include(deltas.join(""), "hello from mock");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("carries its resume cursor across a restart of the adapter", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-resume-restart");
      const wrapperPath = yield* Effect.promise(() => makeMockKiroWrapper());

      // First run: capture the cursor the way the server persists it.
      const firstAdapter = yield* makeTestAdapter(wrapperPath);
      const firstSession = yield* firstAdapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const persistedCursor = firstSession.resumeCursor;
      yield* firstAdapter.stopSession(threadId);
      assert.isFalse(yield* firstAdapter.hasSession(threadId));

      // Second run: a brand new adapter, as after a server restart.
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-restart-log-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.log");
      const restartedWrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const secondAdapter = yield* makeTestAdapter(restartedWrapperPath);
      const resumedSession = yield* secondAdapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: persistedCursor,
      });

      const methods = yield* Effect.promise(() => readRequestMethods(requestLogPath));
      assert.include(methods, "session/load");
      assert.deepStrictEqual(resumedSession.resumeCursor, persistedCursor);

      yield* secondAdapter.stopSession(threadId);
    }),
  );

  it.effect("ignores a resume cursor it does not understand and starts fresh", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-resume-unknown-version");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-resume-unknown-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      // A cursor written by a future build must not be misread.
      yield* adapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 99, sessionId: "from-the-future" },
      });

      const methods = yield* Effect.promise(() => readRequestMethods(requestLogPath));
      assert.include(methods, "session/new");
      assert.notInclude(methods, "session/load");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects a turn with neither text nor attachments", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-empty-turn");
      const wrapperPath = yield* Effect.promise(() => makeMockKiroWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "   ", attachments: [] }),
      );
      assert.equal(error._tag, "ProviderAdapterValidationError");

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.find((entry) => entry.threadId === threadId)?.status, "ready");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("refuses to start a session for another provider", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockKiroWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId: ThreadId.make("kiro-wrong-provider"),
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("reports no provider-side rollback", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-rollback");
      const wrapperPath = yield* Effect.promise(() => makeMockKiroWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: KIRO_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const validation = yield* Effect.flip(adapter.rollbackThread(threadId, 0));
      assert.equal(validation._tag, "ProviderAdapterValidationError");

      const unsupported = yield* Effect.flip(adapter.rollbackThread(threadId, 1));
      assert.equal(unsupported._tag, "ProviderAdapterRequestError");

      yield* adapter.stopSession(threadId);
    }),
  );
});
