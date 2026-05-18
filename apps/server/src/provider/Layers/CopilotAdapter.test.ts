import * as path from "node:path";
import * as os from "node:os";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { COPILOT_PLAN_MODE_ID } from "../acp/CopilotAcpSupport.ts";
import { CopilotAdapter } from "../Services/CopilotAdapter.ts";
import { makeCopilotAdapterLive } from "./CopilotAdapter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const bunExe = "bun";
const COPILOT_DRIVER = ProviderDriverKind.make("copilot");
const COPILOT_INSTANCE_ID = ProviderInstanceId.make("copilot");

const isolateCopilotHome = Effect.fn("isolateCopilotHome")(function* () {
  const previousHome = process.env.HOME;
  const temporaryHome = yield* Effect.promise(() =>
    mkdtemp(path.join(os.tmpdir(), "copilot-adapter-home-")),
  );
  process.env.HOME = temporaryHome;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }),
  );
  return temporaryHome;
});

async function makeMockCopilotWrapper(
  extraEnv?: Record<string, string>,
  options?: { argvLogPath?: string },
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "copilot-acp-mock-"));
  const wrapperPath = path.join(dir, "fake-copilot.sh");
  const envExports = Object.entries({
    T3_ACP_AUTH_METHODS: "copilot-login",
    ...extraEnv,
  })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const argvLog = options?.argvLogPath
    ? `printf '%s\\t' "$@" >> ${JSON.stringify(options.argvLogPath)}
printf '\\n' >> ${JSON.stringify(options.argvLogPath)}`
    : "";
  const script = `#!/bin/sh
${argvLog}
${envExports}
exec ${JSON.stringify(bunExe)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function makeExitingCopilotWrapper(exitCode: number) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "copilot-acp-exit-"));
  const wrapperPath = path.join(dir, "fake-copilot-exit.sh");
  const script = `#!/bin/sh
exit ${exitCode}
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readArgvLog(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t").filter((token) => token.length > 0));
}

const copilotAdapterTestLayer = it.layer(
  makeCopilotAdapterLive().pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-copilot-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

copilotAdapterTestLayer("CopilotAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-mock-thread");

      yield* isolateCopilotHome();

      const wrapperPath = yield* Effect.promise(() => makeMockCopilotWrapper());
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: COPILOT_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
      });

      assert.equal(session.provider, "copilot");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const types = runtimeEvents.map((event) => event.type);

      for (const type of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ] as const) {
        assert.include(types, type);
      }

      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.provider, "copilot");
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("drops assistant history chunks emitted while resuming a Copilot ACP session", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-resume-history-thread");

      yield* isolateCopilotHome();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockCopilotWrapper({
          T3_ACP_LOAD_SESSION_AGENT_TEXT: "stale history",
          T3_ACP_PROMPT_RESPONSE_TEXT: "fresh answer",
        }),
      );
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: COPILOT_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 1,
          sessionId: "mock-session-1",
        },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello after resume",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const assistantDeltas = runtimeEvents.flatMap((event) =>
        event.type === "content.delta" ? [event.payload.delta] : [],
      );

      assert.deepEqual(assistantDeltas, ["fresh answer"]);
      assert.notInclude(assistantDeltas, "stale history");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reports running status while a Copilot prompt is in flight", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-in-flight-status-thread");

      yield* isolateCopilotHome();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockCopilotWrapper({ T3_ACP_PROMPT_DELAY_MS: "1000" }),
      );
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: COPILOT_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
      });

      const turnStartedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.started"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      const turnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "slow mock",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const turnStarted = Array.from(yield* Fiber.join(turnStartedFiber))[0];
      assert.isDefined(turnStarted);
      if (turnStarted?.type !== "turn.started") {
        assert.fail("Expected turn.started event");
        return;
      }

      const inFlightSessions = yield* adapter.listSessions();
      const inFlightSession = inFlightSessions.find((session) => session.threadId === threadId);
      assert.equal(inFlightSession?.status, "running");
      assert.equal(inFlightSession?.activeTurnId, turnStarted.turnId);

      yield* Fiber.join(turnFiber);

      const settledSessions = yield* adapter.listSessions();
      const settledSession = settledSessions.find((session) => session.threadId === threadId);
      assert.equal(settledSession?.status, "ready");
      assert.isUndefined(settledSession?.activeTurnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reports an actionable startup error when Copilot ACP exits before initialize", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-acp-exit-thread");

      yield* isolateCopilotHome();

      const wrapperPath = yield* Effect.promise(() => makeExitingCopilotWrapper(0));
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      const error = yield* adapter
        .startSession({
          threadId,
          provider: COPILOT_DRIVER,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterProcessError");
      if (error._tag === "ProviderAdapterProcessError") {
        assert.include(error.detail, "GitHub Copilot ACP process exited with code 0");
        assert.include(error.detail, "copilot update");
        assert.include(error.detail, "restart T3 Code");
      }
    }),
  );

  it.effect("keeps Copilot read snapshots from retaining base64 attachment payloads", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const config = yield* ServerConfig;
      const threadId = ThreadId.make("copilot-retained-attachment-thread");

      yield* isolateCopilotHome();

      const wrapperPath = yield* Effect.promise(() => makeMockCopilotWrapper());
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      const attachmentId = "copilot-retained-image";
      const imageBytes = Buffer.from("image-bytes-kept-out-of-snapshots");
      yield* Effect.promise(() => mkdir(config.attachmentsDir, { recursive: true }));
      yield* Effect.promise(() =>
        writeFile(path.join(config.attachmentsDir, `${attachmentId}.png`), imageBytes),
      );

      yield* adapter.startSession({
        threadId,
        provider: COPILOT_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "inspect this image",
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: imageBytes.byteLength,
          },
        ],
      });

      const snapshot = yield* adapter.readThread(threadId);
      const firstItem = snapshot.turns[0]?.items[0] as
        | { readonly prompt?: ReadonlyArray<Record<string, unknown>> }
        | undefined;
      const imagePart = firstItem?.prompt?.find((part) => part.type === "image");

      assert.equal(imagePart?.data, undefined);
      assert.equal(imagePart?.dataLength, imageBytes.toString("base64").length);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("starts Copilot with ACP args and switches modes via session/set_mode", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-mode-thread");

      yield* isolateCopilotHome();

      const tempDir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "copilot-adapter-mode-")),
      );
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const argvLogPath = path.join(tempDir, "argv.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockCopilotWrapper(
          {
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          },
          { argvLogPath },
        ),
      );
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: COPILOT_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "plan this",
        attachments: [],
        interactionMode: "plan",
      });

      const argv = yield* Effect.promise(() => readArgvLog(argvLogPath));
      assert.deepEqual(argv[0], ["--acp", "--allow-all"]);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests.map((request) => request.method);
      assert.include(methods, "initialize");
      assert.include(methods, "authenticate");
      assert.include(methods, "session/new");
      assert.include(methods, "session/set_mode");
      assert.include(methods, "session/prompt");

      const setModePayloads = requests
        .filter((request) => request.method === "session/set_mode")
        .map((request) => request.params as { readonly modeId?: string });
      assert.deepEqual(
        setModePayloads.map((payload) => payload.modeId),
        [COPILOT_PLAN_MODE_ID],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not add allow-all startup args outside full-access", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      yield* isolateCopilotHome();

      const tempDir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "copilot-adapter-runtime-modes-")),
      );
      const argvLogPath = path.join(tempDir, "argv.log");
      const wrapperPath = yield* Effect.promise(() => makeMockCopilotWrapper({}, { argvLogPath }));
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId: ThreadId.make("copilot-approval-required-thread"),
        provider: COPILOT_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
      });
      yield* adapter.stopSession(ThreadId.make("copilot-approval-required-thread"));

      yield* adapter.startSession({
        threadId: ThreadId.make("copilot-auto-accept-thread"),
        provider: COPILOT_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "auto-accept-edits",
        modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
      });
      yield* adapter.stopSession(ThreadId.make("copilot-auto-accept-thread"));

      const argv = yield* Effect.promise(() => readArgvLog(argvLogPath));
      assert.deepEqual(argv[0], ["--acp"]);
      assert.deepEqual(argv[1], ["--acp"]);
    }),
  );

  it.effect("throttles leaked full-access permission warnings to one per permission kind", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-warning-throttle-thread");

      yield* isolateCopilotHome();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockCopilotWrapper({
          T3_ACP_PERMISSION_REQUEST_COUNT: "2",
          T3_ACP_PERMISSION_REQUEST_KIND: "execute",
        }),
      );
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: COPILOT_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
      });

      const relevantEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "runtime.warning" ||
            event.type === "request.opened" ||
            event.type === "turn.completed",
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.sendTurn({
        threadId,
        input: "trigger repeated leaked permissions",
        attachments: [],
      });

      const events = Array.from(yield* Fiber.join(relevantEventsFiber));
      assert.deepEqual(
        events.map((event) => event.type),
        ["runtime.warning", "turn.completed"],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces leaked permission requests in approval-required mode", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-approval-request-thread");

      yield* isolateCopilotHome();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockCopilotWrapper({
          T3_ACP_PERMISSION_REQUEST_COUNT: "1",
          T3_ACP_PERMISSION_REQUEST_KIND: "edit",
        }),
      );
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: COPILOT_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
      });

      const requestedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "request.opened"),
        Stream.runHead,
        Effect.forkChild,
      );

      const turnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "trigger visible permission request",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Fiber.join(requestedEventFiber);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "request.opened") {
        assert.fail("Expected request.opened event");
        return;
      }

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(requestedEvent.value.requestId!),
        "accept",
      );

      yield* Fiber.join(turnFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "applies configured Copilot models and reasoning effort through ACP session config",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CopilotAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("copilot-model-thread");

        yield* isolateCopilotHome();

        const tempDir = yield* Effect.promise(() =>
          mkdtemp(path.join(os.tmpdir(), "copilot-adapter-model-")),
        );
        const requestLogPath = path.join(tempDir, "requests.ndjson");
        const projectDir = path.join(tempDir, "project");

        const wrapperPath = yield* Effect.promise(() =>
          makeMockCopilotWrapper({
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          }),
        );
        yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });
        yield* Effect.promise(() => mkdir(path.join(projectDir, ".copilot"), { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(
            path.join(projectDir, ".copilot", "config.json"),
            JSON.stringify({ model: "composer-2" }),
            "utf8",
          ),
        );

        yield* adapter.startSession({
          threadId,
          provider: COPILOT_DRIVER,
          cwd: projectDir,
          runtimeMode: "full-access",
          modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
        });
        yield* adapter.sendTurn({
          threadId,
          input: "use configured model",
          attachments: [],
          modelSelection: {
            instanceId: COPILOT_INSTANCE_ID,
            model: "gpt-5.4",
            options: [{ id: "reasoning", value: "xhigh" }],
          },
        });

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const setConfigPayloads = requests
          .filter((request) => request.method === "session/set_config_option")
          .map(
            (request) => request.params as { readonly configId?: string; readonly value?: string },
          );

        assert.deepEqual(
          setConfigPayloads
            .filter((payload) => payload.configId === "model")
            .map((payload) => payload.value),
          ["composer-2", "gpt-5.4"],
        );
        assert.deepEqual(
          setConfigPayloads
            .filter((payload) => payload.configId === "reasoning_effort")
            .map((payload) => payload.value),
          ["xhigh"],
        );

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("routes ACP form elicitation through user-input lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-elicitation-thread");

      yield* isolateCopilotHome();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockCopilotWrapper({
          T3_ACP_EMIT_ELICITATION: "1",
        }),
      );
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      const session = yield* adapter.startSession({
        threadId,
        provider: COPILOT_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
      });

      const requestedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "user-input.requested"),
        Stream.runHead,
        Effect.forkChild,
      );
      const resolvedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "user-input.resolved"),
        Stream.runHead,
        Effect.forkChild,
      );
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "deploy",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Fiber.join(requestedEventFiber);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }

      assert.equal(requestedEvent.value.threadId, session.threadId);
      assert.equal(requestedEvent.value.payload.questions[0]?.id, "environment");
      assert.equal(requestedEvent.value.payload.questions[1]?.id, "runChecks");
      assert.deepEqual(
        requestedEvent.value.payload.questions[0]?.options.map((option) => option.label),
        ["staging", "production"],
      );

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(requestedEvent.value.requestId!),
        {
          environment: "staging",
          runChecks: "true",
        },
      );

      const resolvedEvent = yield* Fiber.join(resolvedEventFiber);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {
        environment: "staging",
        runChecks: "true",
      });

      const turn = yield* Fiber.join(sendFiber);
      assert.equal(turn.threadId, threadId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("uses SIGINT to stop a Copilot turn and resumes the session afterward", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-interrupt-thread");

      yield* isolateCopilotHome();

      const tempDir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "copilot-adapter-interrupt-")),
      );
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const exitLogPath = path.join(tempDir, "exits.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockCopilotWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
          T3_ACP_IGNORE_CANCEL: "1",
          T3_ACP_PROMPT_DELAY_MS: "2000",
          T3_ACP_PROMPT_STARTED_TEXT: "waiting for interrupt",
        }),
      );
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      const completedTurnsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      const turnStartedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "waiting for interrupt",
        ),
        Stream.runHead,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: COPILOT_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
      });

      const interruptedTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "hang until interrupted",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const promptStarted = yield* Fiber.join(turnStartedFiber);
      assert.equal(promptStarted._tag, "Some");
      yield* adapter.interruptTurn(threadId);
      yield* adapter.interruptTurn(threadId);

      const interruptedTurn = yield* Fiber.join(interruptedTurnFiber);
      assert.equal(interruptedTurn.threadId, threadId);
      assert.deepEqual(interruptedTurn.resumeCursor, session.resumeCursor);

      const resumedTurn = yield* adapter.sendTurn({
        threadId,
        input: "after interrupt",
        attachments: [],
      });
      assert.equal(resumedTurn.threadId, threadId);

      const completedTurns = Array.from(yield* Fiber.join(completedTurnsFiber));
      assert.lengthOf(completedTurns, 2);
      assert.equal(completedTurns[0]?.payload.state, "cancelled");
      assert.equal(completedTurns[0]?.payload.stopReason, "cancelled");
      assert.equal(completedTurns[1]?.payload.state, "completed");

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests.map((request) => request.method);
      assert.equal(methods.filter((method) => method === "session/load").length, 1);
      assert.equal(methods.filter((method) => method === "session/prompt").length, 2);

      const exitLog = yield* Effect.promise(() => readFile(exitLogPath, "utf8"));
      assert.equal(exitLog.split("\n").filter((line) => line === "SIGINT").length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restarts resumed sessions with updated runtime-mode startup args", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-resume-mode-change-thread");

      yield* isolateCopilotHome();

      const tempDir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "copilot-adapter-resume-mode-change-")),
      );
      const argvLogPath = path.join(tempDir, "argv.log");
      const wrapperPath = yield* Effect.promise(() => makeMockCopilotWrapper({}, { argvLogPath }));
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      const initialSession = yield* adapter.startSession({
        threadId,
        provider: COPILOT_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
      });
      yield* adapter.stopSession(threadId);

      yield* adapter.startSession({
        threadId,
        provider: COPILOT_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: initialSession.resumeCursor,
        modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
      });
      yield* adapter.stopSession(threadId);

      const argv = yield* Effect.promise(() => readArgvLog(argvLogPath));
      assert.deepEqual(argv[0], ["--acp"]);
      assert.deepEqual(argv[1], ["--acp", "--allow-all"]);
    }),
  );

  it.effect("optionally smoke-tests the real Copilot binary with full-access ACP startup", () =>
    Effect.gen(function* () {
      if (process.env.T3_RUN_REAL_COPILOT_SMOKE !== "1") {
        return;
      }

      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-real-binary-smoke-thread");

      yield* settings.updateSettings({
        providers: {
          copilot: {
            binaryPath: process.env.T3_REAL_COPILOT_BINARY ?? "copilot",
          },
        },
      });

      const session = yield* adapter.startSession({
        threadId,
        provider: COPILOT_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: COPILOT_INSTANCE_ID, model: "auto" },
      });

      assert.equal(session.provider, "copilot");
      yield* adapter.stopSession(threadId);
    }),
  );
});
