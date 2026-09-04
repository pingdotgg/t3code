// This suite builds real mock-agent wrapper scripts and temp directories on
// disk, so direct node: imports are intentional.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { createModelSelection } from "@t3tools/shared/model";

import {
  ApprovalRequestId,
  OmpSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { describe, expect, it as plainIt } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { OmpAdapterShape } from "../Services/OmpAdapter.ts";
import {
  makeOmpAdapter,
  ompElicitationContentFromAnswers,
  ompElicitationQuestionsFromForm,
  parseOmpSubagentSpawns,
  selectOmpPermissionOptionId,
} from "./OmpAdapter.ts";
const decodeOmpSettings = Schema.decodeSync(OmpSettings);

// Test-local service tag so the rest of the file can keep using `yield* OmpAdapter`.
class OmpAdapter extends Context.Service<OmpAdapter, OmpAdapterShape>()(
  "t3/provider/Layers/OmpAdapter.test/OmpAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = "node";
const mockAgentArgs = [mockAgentPath] as const;

async function makeMockAgentWrapper(
  extraEnv?: Record<string, string>,
  options?: { initialDelaySeconds?: number },
) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-omp.sh");
  const envExports = Object.entries({ T3_ACP_OMP_SHAPES: "1", ...extraEnv })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
${options?.initialDelaySeconds ? `sleep ${JSON.stringify(String(options.initialDelaySeconds))}` : ""}
exec ${JSON.stringify(mockAgentCommand)} ${mockAgentArgs.map((arg) => JSON.stringify(arg)).join(" ")} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function makeProbeWrapper(
  requestLogPath: string,
  argvLogPath: string,
  extraEnv?: Record<string, string>,
) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-probe-"));
  const wrapperPath = NodePath.join(dir, "fake-omp.sh");
  const envExports = Object.entries({ T3_ACP_OMP_SHAPES: "1", ...extraEnv })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
printf '%s\t' "$@" >> ${JSON.stringify(argvLogPath)}
printf '\n' >> ${JSON.stringify(argvLogPath)}
export T3_ACP_REQUEST_LOG_PATH=${JSON.stringify(requestLogPath)}
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${mockAgentArgs.map((arg) => JSON.stringify(arg)).join(" ")} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readArgvLog(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t").filter((token) => token.length > 0));
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForFileContent(filePath: string, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const raw = await NodeFSP.readFile(filePath, "utf8");
      if (raw.trim().length > 0) {
        return raw;
      }
    } catch {}
    await Effect.runPromise(Effect.yieldNow);
  }
  throw new Error(`Timed out waiting for file content at ${filePath}`);
}

function waitForJsonLogMatch(
  filePath: string,
  predicate: (entry: Record<string, unknown>) => boolean,
  attempts = 40,
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const requests = yield* Effect.promise(() => readJsonLines(filePath));
      if (requests.some(predicate)) {
        return requests;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.promise(() => readJsonLines(filePath));
  });
}

// Tests mutate `ServerSettingsService` mid-flight (e.g. setting
// `providers.omp.binaryPath` to a mock ACP wrapper). The adapter
// captures `ompSettings` once at construction, so without a resolver
// the mutation is invisible — sessions would spawn the constructor's
// (empty) binary path. Wiring `resolveSettings` through
// `ServerSettingsService.getSettings` makes each session read the latest
// snapshot, matching the old "always read live" behavior that these
// tests assumed.
const makeResolveOmpSettings = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  return yield* Effect.succeed(
    serverSettings.getSettings.pipe(
      Effect.map((snapshot) => snapshot.providers.omp),
      Effect.orDie,
    ),
  );
});

const makeOmpAdapterTestLayer = (instanceId?: ProviderInstanceId) =>
  Layer.effect(
    OmpAdapter,
    Effect.gen(function* () {
      const ompConfig = decodeOmpSettings({});
      const resolveSettings = yield* makeResolveOmpSettings;
      return yield* makeOmpAdapter(ompConfig, {
        ...(instanceId ? { instanceId } : {}),
        resolveSettings,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-omp-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const elicitationFormRequest = {
  mode: "form",
  sessionId: "mock-session-1",
  message: "Approve this action?",
  requestedSchema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        title: "Decision",
        description: "Pick one",
        enum: ["Approve", "Deny"],
      },
      confirm: { type: "boolean", title: "Confirm" },
      notes: { type: "string" },
      tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
    },
    required: ["decision"],
  },
} as const;

describe("ompElicitationQuestionsFromForm", () => {
  plainIt("maps a string enum property onto a select question", () => {
    const questions = ompElicitationQuestionsFromForm(elicitationFormRequest);
    expect(questions[0]).toEqual({
      id: "decision",
      header: "Decision",
      question: "Pick one",
      multiSelect: false,
      options: [
        { label: "Approve", description: "Approve" },
        { label: "Deny", description: "Deny" },
      ],
    });
  });

  plainIt("maps a boolean property onto True/False options", () => {
    const questions = ompElicitationQuestionsFromForm(elicitationFormRequest);
    expect(questions[1]).toEqual({
      id: "confirm",
      header: "Confirm",
      question: "Approve this action?",
      multiSelect: false,
      options: [
        { label: "True", description: "Yes" },
        { label: "False", description: "No" },
      ],
    });
  });

  plainIt("falls back to free text for properties without enums", () => {
    const questions = ompElicitationQuestionsFromForm(elicitationFormRequest);
    expect(questions[2]).toMatchObject({ id: "notes", header: "notes", options: [] });
    expect(questions[3]).toMatchObject({ id: "tags", header: "tags", options: [] });
  });

  plainIt("uses a fallback question when the message is empty", () => {
    const questions = ompElicitationQuestionsFromForm({
      mode: "form",
      sessionId: "mock-session-1",
      message: "   ",
      requestedSchema: { type: "object", properties: { value: { type: "string" } } },
    });
    expect(questions[0]?.question).toBe("Oh My Pi requests input.");
  });
});

describe("ompElicitationContentFromAnswers", () => {
  plainIt("maps option labels and booleans back to content values", () => {
    expect(
      ompElicitationContentFromAnswers(elicitationFormRequest, {
        decision: "Deny",
        confirm: "False",
        notes: "looks risky",
        tags: ["a", "b"],
      }),
    ).toEqual({
      decision: "Deny",
      confirm: false,
      notes: "looks risky",
      tags: ["a", "b"],
    });
  });

  plainIt("omits unanswered and empty answers", () => {
    expect(
      ompElicitationContentFromAnswers(elicitationFormRequest, {
        decision: "  ",
        notes: "ok",
      }),
    ).toEqual({ notes: "ok" });
    expect(ompElicitationContentFromAnswers(elicitationFormRequest, {})).toEqual({});
  });
});

describe("parseOmpSubagentSpawns", () => {
  plainIt("parses a single task tool call", () => {
    expect(
      parseOmpSubagentSpawns("tool-1", {
        agent: "worker",
        task: "Implement the feature",
        effort: "high",
      }),
    ).toEqual([
      { taskId: "tool-1", title: "Implement the feature", role: "worker", effort: "high" },
    ]);
  });

  plainIt("parses a batch task tool call into one spawn per item", () => {
    expect(
      parseOmpSubagentSpawns("tool-1", {
        tasks: [
          { agent: "scout", task: "Research the codebase layout", effort: "low" },
          { agent: "worker", task: "Implement the feature" },
        ],
        context: "shared batch context",
      }),
    ).toEqual([
      { taskId: "tool-1:0", title: "Research the codebase layout", role: "scout", effort: "low" },
      { taskId: "tool-1:1", title: "Implement the feature", role: "worker" },
    ]);
  });

  plainIt("rejects inputs with keys outside the omp task schema", () => {
    expect(parseOmpSubagentSpawns("tool-1", { task: "x", url: "https://example.com" })).toEqual([]);
    expect(parseOmpSubagentSpawns("tool-1", { tasks: [{ task: "x" }], command: ["ls"] })).toEqual(
      [],
    );
  });

  plainIt("rejects non-task tools and empty task payloads", () => {
    expect(parseOmpSubagentSpawns("tool-1", { command: ["ls"] })).toEqual([]);
    expect(parseOmpSubagentSpawns("tool-1", { task: "   " })).toEqual([]);
    expect(parseOmpSubagentSpawns("tool-1", { tasks: [{ name: "no task field" }] })).toEqual([]);
    expect(parseOmpSubagentSpawns("tool-1", "not an object")).toEqual([]);
  });
});

describe("selectOmpPermissionOptionId", () => {
  const request = (
    options: ReadonlyArray<{ kind: string; optionId: string }>,
  ): Parameters<typeof selectOmpPermissionOptionId>[0] =>
    ({ options }) as never;

  plainIt("matches the decision kind against the advertised option id", () => {
    const req = request([
      { kind: "allow_once", optionId: "allow_once" },
      { kind: "allow_always", optionId: "allow_always" },
      { kind: "reject_once", optionId: "reject_once" },
    ]);
    expect(selectOmpPermissionOptionId(req, "accept")).toBe("allow_once");
    expect(selectOmpPermissionOptionId(req, "acceptForSession")).toBe("allow_always");
    expect(selectOmpPermissionOptionId(req, "decline")).toBe("reject_once");
  });

  plainIt("falls back to allow_once when the agent offers no allow_always", () => {
    const req = request([{ kind: "allow_once", optionId: "yes-once" }]);
    expect(selectOmpPermissionOptionId(req, "acceptForSession")).toBe("yes-once");
  });

  plainIt("skips options with blank ids and prefers reject_once over reject_always", () => {
    const req = request([
      { kind: "reject_once", optionId: "   " },
      { kind: "reject_always", optionId: "never" },
    ]);
    expect(selectOmpPermissionOptionId(req, "decline")).toBe("never");
  });

  plainIt("returns undefined when nothing usable was offered", () => {
    const req = request([{ kind: "allow_once", optionId: "ok" }]);
    expect(selectOmpPermissionOptionId(req, "decline")).toBeUndefined();
  });
});

const ompAdapterTestLayer = it.layer(makeOmpAdapterTestLayer());

ompAdapterTestLayer("OmpAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-mock-thread");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      assert.equal(session.provider, "omp");
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
      const types = runtimeEvents.map((e) => e.type);

      for (const t of [
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
        assert.include(types, t);
      }

      const assistantStarted = runtimeEvents.find(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      assert.isDefined(assistantStarted);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
        assert.match(String(delta.itemId), /^assistant:mock-session-1:runtime:[^:]+:segment:0$/);
      }

      const assistantCompleted = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.isDefined(assistantCompleted);

      const planUpdate = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.isDefined(planUpdate);
      if (planUpdate?.type === "turn.plan.updated") {
        assert.deepStrictEqual(planUpdate.payload.plan, [
          { step: "Inspect mock ACP state", status: "completed" },
          { step: "Implement the requested change", status: "inProgress" },
        ]);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("steers a running turn instead of opening a new one on mid-turn sendTurn", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-steer-thread");

      // Keep the first prompt in flight long enough for the steer to land.
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_PROMPT_DELAY_MS: "1500" }),
      );
      yield* settings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      const firstTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "run 5 commands",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      // Poll until the first prompt is in flight — sendTurn binds the active
      // turn id before prompting. The mock agent runs on the real clock, so
      // each TestClock.adjust just provides the scheduler hops for its stdio
      // responses to land.
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const sessions = yield* adapter.listSessions();
          const session = sessions.find((entry) => entry.threadId === threadId);
          if (session?.activeTurnId !== undefined) {
            return;
          }
          yield* TestClock.adjust("10 millis");
        }
        throw new Error("Timed out waiting for the first prompt to be in flight.");
      });

      // Steer: a second sendTurn while the first prompt is still in flight
      // continues the same turn.
      const steeredTurn = yield* adapter.sendTurn({
        threadId,
        input: "actually run 15",
        attachments: [],
      });
      const firstTurn = yield* Fiber.join(firstTurnFiber);
      assert.equal(String(steeredTurn.turnId), String(firstTurn.turnId));

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const turnStartedEvents = runtimeEvents.filter((event) => event.type === "turn.started");
      const turnCompletedEvents = runtimeEvents.filter((event) => event.type === "turn.completed");

      // One turn boundary for the whole run: the superseded first prompt
      // resolving must not settle the merged turn.
      assert.equal(turnStartedEvents.length, 1);
      assert.equal(String(turnStartedEvents[0]?.turnId), String(firstTurn.turnId));
      assert.equal(turnCompletedEvents.length, 1);
      assert.equal(String(turnCompletedEvents[0]?.turnId), String(firstTurn.turnId));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      yield* settings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* Effect.promise(() => waitForFileContent(exitLogPath));
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect(
    "serializes concurrent startSession calls for the same thread and closes the replaced ACP session",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OmpAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("omp-concurrent-start-session");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-adapter-concurrent-exit-log-")),
        );
        const exitLogPath = NodePath.join(tempDir, "exit.log");

        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper(
            {
              T3_ACP_EXIT_LOG_PATH: exitLogPath,
            },
            { initialDelaySeconds: 0.2 },
          ),
        );
        yield* settings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

        const [firstSession, secondSession] = yield* Effect.all(
          [
            adapter.startSession({
              threadId,
              provider: ProviderDriverKind.make("omp"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
              modelSelection: {
                instanceId: ProviderInstanceId.make("omp"),
                model: "openai/gpt-5.4",
              },
            }),
            adapter.startSession({
              threadId,
              provider: ProviderDriverKind.make("omp"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
              modelSelection: {
                instanceId: ProviderInstanceId.make("omp"),
                model: "openai/gpt-5.4",
              },
            }),
          ],
          { concurrency: "unbounded" },
        );

        assert.equal(firstSession.threadId, threadId);
        assert.equal(secondSession.threadId, threadId);

        yield* adapter.stopSession(threadId);

        const exitLog = yield* Effect.promise(() => waitForFileContent(exitLogPath));
        assert.equal(exitLog.match(/SIGTERM/g)?.length ?? 0, 2);
      }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const result = yield* adapter
        .startSession({
          threadId: ThreadId.make("bad-provider"),
          provider: ProviderDriverKind.make("codex"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("maps app plan mode onto the ACP plan session mode", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-plan-mode-probe");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "plan this change",
        attachments: [],
        interactionMode: "plan",
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeRequest = requests
        .toReversed()
        .find(
          (entry) =>
            entry.method === "session/set_mode" ||
            (entry.method === "session/set_config_option" &&
              (entry.params as Record<string, unknown> | undefined)?.configId === "mode"),
        );
      assert.isDefined(modeRequest);
      assert.equal(
        (modeRequest?.params as Record<string, unknown> | undefined)?.sessionId,
        "mock-session-1",
      );
      assert.equal(
        String(
          (modeRequest?.params as Record<string, unknown> | undefined)?.modeId ??
            (modeRequest?.params as Record<string, unknown> | undefined)?.value,
        ),
        "plan",
      );
    }),
  );

  it.effect(
    "applies initial model and mode configuration during startSession and skips repeating it on first send",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OmpAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("omp-initial-config-probe");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const argvLogPath = NodePath.join(tempDir, "argv.txt");
        yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath),
        );
        yield* serverSettings.updateSettings({
          providers: { omp: { binaryPath: wrapperPath } },
        });

        const modelSelection = createModelSelection(
          ProviderInstanceId.make("omp"),
          "openai/gpt-5.4",
          [{ id: "reasoning", value: "max" }],
        );

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection,
        });

        yield* Effect.promise(() => waitForFileContent(requestLogPath));

        // The session spawns in the mock's `default` mode already, so only the
        // model and thinking config options are written.
        const requestsAfterStart = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const configIdsAfterStart = requestsAfterStart.flatMap((entry) =>
          entry.method === "session/set_config_option" &&
          typeof (entry.params as Record<string, unknown> | undefined)?.configId === "string"
            ? [String((entry.params as Record<string, unknown>).configId)]
            : [],
        );
        assert.deepStrictEqual(configIdsAfterStart, ["model", "thinking"]);

        yield* adapter.sendTurn({
          threadId,
          input: "hello mock",
          attachments: [],
          modelSelection,
          interactionMode: "default",
        });
        yield* adapter.stopSession(threadId);

        const finalRequests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const finalConfigIds = finalRequests.flatMap((entry) =>
          entry.method === "session/set_config_option" &&
          typeof (entry.params as Record<string, unknown> | undefined)?.configId === "string"
            ? [String((entry.params as Record<string, unknown>).configId)]
            : [],
        );
        assert.deepStrictEqual(finalConfigIds, ["model", "thinking"]);
        assert.equal(finalRequests.filter((entry) => entry.method === "session/prompt").length, 1);
      }),
  );

  it.effect(
    "streams ACP tool calls and approvals on the active turn in approval-required mode",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OmpAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("omp-tool-call-probe");
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const settledEventTypes = new Set<string>();
        const settledEventsReady = yield* Deferred.make<void>();

        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
        );
        yield* serverSettings.updateSettings({
          providers: { omp: { binaryPath: wrapperPath } },
        });

        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            runtimeEvents.push(event);
            if (String(event.threadId) !== String(threadId)) {
              return;
            }
            if (event.type === "request.opened" && event.requestId) {
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                "accept",
              );
            }
            if (
              event.type === "turn.completed" ||
              (event.type === "item.completed" && event.payload.itemType === "command_execution") ||
              event.type === "content.delta"
            ) {
              settledEventTypes.add(event.type);
              if (settledEventTypes.size === 3) {
                yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
              }
            }
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
        });

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "run a tool call",
          attachments: [],
        });
        yield* Deferred.await(settledEventsReady);

        const threadEvents = runtimeEvents.filter(
          (event) => String(event.threadId) === String(threadId),
        );
        assert.includeMembers(
          threadEvents.map((event) => event.type),
          [
            "session.started",
            "session.state.changed",
            "thread.started",
            "turn.started",
            "request.opened",
            "request.resolved",
            "item.updated",
            "item.completed",
            "content.delta",
            "turn.completed",
          ],
        );

        const turnEvents = threadEvents.filter(
          (event) => String(event.turnId) === String(turn.turnId),
        );
        const toolUpdates = turnEvents.filter((event) => event.type === "item.updated");
        // ACP updates can arrive either as distinct pending + in-progress events
        // or as a single coalesced in-progress update before approval resolves.
        assert.isAtLeast(toolUpdates.length, 1);
        for (const toolUpdate of toolUpdates) {
          if (toolUpdate.type !== "item.updated") {
            continue;
          }
          assert.equal(toolUpdate.payload.itemType, "command_execution");
          assert.equal(toolUpdate.payload.status, "inProgress");
          assert.equal(toolUpdate.payload.detail, "cat server/package.json");
          assert.equal(String(toolUpdate.itemId), "tool-call-1");
        }

        const requestOpened = turnEvents.find((event) => event.type === "request.opened");
        assert.isDefined(requestOpened);
        if (requestOpened?.type === "request.opened") {
          assert.equal(String(requestOpened.turnId), String(turn.turnId));
          assert.equal(requestOpened.payload.requestType, "exec_command_approval");
          assert.equal(requestOpened.payload.detail, "cat server/package.json");
        }

        const requestResolved = turnEvents.find((event) => event.type === "request.resolved");
        assert.isDefined(requestResolved);
        if (requestResolved?.type === "request.resolved") {
          assert.equal(String(requestResolved.turnId), String(turn.turnId));
          assert.equal(requestResolved.payload.requestType, "exec_command_approval");
          assert.equal(requestResolved.payload.decision, "accept");
        }

        const toolCompleted = turnEvents.find(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "command_execution",
        );
        assert.isDefined(toolCompleted);
        if (toolCompleted?.type === "item.completed") {
          assert.equal(String(toolCompleted.turnId), String(turn.turnId));
          assert.equal(toolCompleted.payload.itemType, "command_execution");
          assert.equal(toolCompleted.payload.status, "completed");
          assert.equal(toolCompleted.payload.detail, "cat server/package.json");
          assert.equal(String(toolCompleted.itemId), "tool-call-1");
        }

        const contentDelta = turnEvents.find((event) => event.type === "content.delta");
        assert.isDefined(contentDelta);
        if (contentDelta?.type === "content.delta") {
          assert.equal(String(contentDelta.turnId), String(turn.turnId));
          assert.equal(contentDelta.payload.delta, "hello from mock");
          assert.match(
            String(contentDelta.itemId),
            /^assistant:mock-session-1:runtime:[^:]+:segment:0$/,
          );
        }
      }),
  );

  it.effect(
    "auto-approves ACP tool permissions in full-access mode without approval runtime events",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OmpAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("omp-full-access-auto-approve");
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const settledEventTypes = new Set<string>();
        const settledEventsReady = yield* Deferred.make<void>();
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const argvLogPath = NodePath.join(tempDir, "argv.txt");
        yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_EMIT_TOOL_CALLS: "1" }),
        );
        yield* serverSettings.updateSettings({
          providers: { omp: { binaryPath: wrapperPath } },
        });

        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            runtimeEvents.push(event);
            if (String(event.threadId) !== String(threadId)) {
              return;
            }
            if (
              event.type === "turn.completed" ||
              (event.type === "item.completed" && event.payload.itemType === "command_execution") ||
              event.type === "content.delta"
            ) {
              settledEventTypes.add(event.type);
              if (settledEventTypes.size === 3) {
                yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
              }
            }
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
        });

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "run a tool call",
          attachments: [],
        });

        yield* Deferred.await(settledEventsReady);
        yield* Fiber.interrupt(runtimeEventsFiber);

        const turnEvents = runtimeEvents.filter(
          (event) =>
            String(event.threadId) === String(threadId) &&
            String(event.turnId) === String(turn.turnId),
        );
        assert.notInclude(
          turnEvents.map((event) => event.type),
          "request.opened",
        );
        assert.notInclude(
          turnEvents.map((event) => event.type),
          "request.resolved",
        );
        assert.includeMembers(
          turnEvents.map((event) => event.type),
          ["item.updated", "item.completed", "content.delta", "turn.completed"],
        );

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const permissionResponse = requests.find(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "outcome" in entry.result.outcome &&
            entry.result.outcome.outcome === "selected" &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "allow-always",
        );
        assert.isDefined(permissionResponse);

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("segments assistant messages around ACP tool activity in full-access mode", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-assistant-tool-segmentation");
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const settledEventTypes = new Set<string>();
      const settledEventsReady = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath } },
      });

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (
            event.type === "content.delta" ||
            (event.type === "item.completed" && event.payload.itemType === "command_execution") ||
            event.type === "turn.completed"
          ) {
            if (event.type === "content.delta") {
              settledEventTypes.add(`delta:${event.payload.delta}`);
            } else {
              settledEventTypes.add(event.type);
            }
            if (
              settledEventTypes.has("delta:before tool") &&
              settledEventTypes.has("delta:after tool") &&
              settledEventTypes.has("item.completed") &&
              settledEventTypes.has("turn.completed")
            ) {
              yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
            }
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run an interleaved tool call",
        attachments: [],
      });

      yield* Deferred.await(settledEventsReady);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const turnEvents = runtimeEvents.filter(
        (event) =>
          String(event.threadId) === String(threadId) &&
          String(event.turnId) === String(turn.turnId),
      );
      const firstAssistantStartIndex = turnEvents.findIndex(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      const firstAssistantDeltaIndex = turnEvents.findIndex(
        (event) => event.type === "content.delta" && event.payload.delta === "before tool",
      );
      const assistantBoundaryIndex = turnEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      const toolUpdateIndex = turnEvents.findIndex(
        (event) => event.type === "item.updated" && event.payload.itemType === "command_execution",
      );
      const toolCompletedIndex = turnEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      const secondAssistantStartIndex = turnEvents.findIndex(
        (event, index) =>
          index > toolCompletedIndex &&
          event.type === "item.started" &&
          event.payload.itemType === "assistant_message",
      );
      const secondAssistantDeltaIndex = turnEvents.findIndex(
        (event) => event.type === "content.delta" && event.payload.delta === "after tool",
      );

      assert.isAtLeast(firstAssistantStartIndex, 0);
      assert.isAtLeast(firstAssistantDeltaIndex, 0);
      assert.isAtLeast(assistantBoundaryIndex, 0);
      assert.isAtLeast(toolUpdateIndex, 0);
      assert.isAtLeast(toolCompletedIndex, 0);
      assert.isAtLeast(secondAssistantStartIndex, 0);
      assert.isAtLeast(secondAssistantDeltaIndex, 0);
      assert.isBelow(firstAssistantStartIndex, firstAssistantDeltaIndex);
      assert.isBelow(firstAssistantDeltaIndex, assistantBoundaryIndex);
      assert.isBelow(assistantBoundaryIndex, toolUpdateIndex);
      assert.isBelow(toolUpdateIndex, toolCompletedIndex);
      assert.isBelow(toolCompletedIndex, secondAssistantStartIndex);
      assert.isBelow(secondAssistantStartIndex, secondAssistantDeltaIndex);

      const assistantStarts = turnEvents.filter(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      const assistantDeltas = turnEvents.filter((event) => event.type === "content.delta");
      assert.lengthOf(assistantStarts, 2);
      assert.lengthOf(assistantDeltas, 2);
      if (
        assistantStarts[0]?.type === "item.started" &&
        assistantStarts[1]?.type === "item.started" &&
        assistantDeltas[0]?.type === "content.delta" &&
        assistantDeltas[1]?.type === "content.delta"
      ) {
        assert.notEqual(String(assistantStarts[0].itemId), String(assistantStarts[1].itemId));
        assert.equal(String(assistantDeltas[0].itemId), String(assistantStarts[0].itemId));
        assert.equal(String(assistantDeltas[1].itemId), String(assistantStarts[1].itemId));
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancels pending ACP approvals and marks the turn cancelled when interrupted", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-cancel-probe");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      const requestResolvedReady = yield* Deferred.make<ProviderRuntimeEvent>();
      const turnCompletedReady = yield* Deferred.make<ProviderRuntimeEvent>();
      let interrupted = false;

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "request.opened" && event.requestId && !interrupted) {
            interrupted = true;
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "cancel",
            );
            yield* adapter.interruptTurn(threadId);
            return;
          }
          if (event.type === "request.resolved") {
            yield* Deferred.succeed(requestResolvedReady, event).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompletedReady, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel this turn",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const requestResolved = yield* Deferred.await(requestResolvedReady);
      const turnCompleted = yield* Deferred.await(turnCompletedReady);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(runtimeEventsFiber);

      assert.equal(requestResolved.type, "request.resolved");
      if (requestResolved.type === "request.resolved") {
        assert.equal(requestResolved.payload.decision, "cancel");
      }

      assert.equal(turnCompleted.type, "turn.completed");
      if (turnCompleted.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "cancelled");
        assert.equal(turnCompleted.payload.stopReason, "cancelled");
      }

      const isCancelledApprovalResponse = (entry: Record<string, unknown>) =>
        !("method" in entry) &&
        typeof entry.result === "object" &&
        entry.result !== null &&
        "outcome" in entry.result &&
        typeof entry.result.outcome === "object" &&
        entry.result.outcome !== null &&
        "outcome" in entry.result.outcome &&
        entry.result.outcome.outcome === "cancelled";
      const approvalResponses = yield* waitForJsonLogMatch(
        requestLogPath,
        isCancelledApprovalResponse,
      );
      assert.isTrue(approvalResponses.some(isCancelledApprovalResponse));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("stopping a session settles pending approval waits", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-stop-pending-approval");
      const approvalRequested = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId) || event.type !== "request.opened") {
          return Effect.void;
        }
        return Deferred.succeed(approvalRequested, undefined).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "run a tool call and then stop",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(approvalRequested);
      yield* adapter.stopSession(threadId);
      yield* Fiber.await(sendTurnFiber);

      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("bridges omp form elicitations into user-input requests", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-elicitation-probe");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_EMIT_ELICITATION: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const userInputResolved = yield* Deferred.make<void>();

      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "user-input.requested" && event.requestId) {
            yield* adapter.respondToUserInput(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              { value: "Deny" },
            );
          }
          if (event.type === "user-input.resolved") {
            yield* Deferred.succeed(userInputResolved, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "do something that needs approval",
        attachments: [],
      });
      yield* Deferred.await(userInputResolved);

      const threadEvents = runtimeEvents.filter(
        (event) => String(event.threadId) === String(threadId),
      );
      const requested = threadEvents.find((event) => event.type === "user-input.requested");
      assert.isDefined(requested);
      if (requested?.type === "user-input.requested") {
        assert.deepStrictEqual(requested.payload.questions, [
          {
            id: "value",
            header: "Decision",
            question: "Approve this action?",
            multiSelect: false,
            options: [
              { label: "Approve", description: "Approve" },
              { label: "Deny", description: "Deny" },
            ],
          },
        ]);
      }

      const resolved = threadEvents.find((event) => event.type === "user-input.resolved");
      assert.isDefined(resolved);
      if (resolved?.type === "user-input.resolved") {
        assert.deepStrictEqual(resolved.payload.answers, { value: "Deny" });
      }

      // The mock agent logs every incoming JSON-RPC payload, so the client's
      // elicitation response shows up there. omp's official ACP SDK reads a
      // FLAT response ({ action: "accept", content }) — assert exactly that.
      const isElicitationResponse = (entry: Record<string, unknown>) =>
        !("method" in entry) &&
        typeof entry.result === "object" &&
        entry.result !== null &&
        "action" in entry.result &&
        entry.result.action === "accept";
      const responses = yield* waitForJsonLogMatch(requestLogPath, isElicitationResponse);
      const elicitationResponse = responses.find(isElicitationResponse);
      assert.isDefined(elicitationResponse);
      const elicitationResult = elicitationResponse?.result as Record<string, unknown>;
      assert.deepStrictEqual(elicitationResult.content, { value: "Deny" });

      const delta = threadEvents.find(
        (event) => event.type === "content.delta" && event.payload.delta === "elicitation accept",
      );
      assert.isDefined(delta);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("settles the turn as failed when the prompt errors after turn.started", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-prompt-failure");
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const turnSettled = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_FAIL_PROMPT: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) === String(threadId) && event.type === "turn.completed") {
            yield* Deferred.succeed(turnSettled, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      const sendExit = yield* Effect.exit(
        adapter.sendTurn({
          threadId,
          input: "this prompt fails",
          attachments: [],
        }),
      );
      assert.isTrue(Exit.isFailure(sendExit), "sendTurn should still propagate the prompt error");
      yield* Deferred.await(turnSettled);

      const threadEvents = runtimeEvents.filter(
        (event) => String(event.threadId) === String(threadId),
      );
      const turnStartedIndex = threadEvents.findIndex((event) => event.type === "turn.started");
      const turnCompletedIndex = threadEvents.findIndex((event) => event.type === "turn.completed");
      assert.isAtLeast(turnStartedIndex, 0);
      assert.isAbove(turnCompletedIndex, turnStartedIndex);

      const turnCompleted = threadEvents[turnCompletedIndex];
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "failed");
        assert.isString(turnCompleted.payload.errorMessage);
        assert.isNotEmpty(turnCompleted.payload.errorMessage);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancelling during sendTurn preparation prevents the prompt from being sent", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-prepare-cancel");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      // Slow set_config_option responses keep the prepare phase busy long
      // enough for interruptTurn to land before the prompt goes out.
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, {
          T3_ACP_SET_CONFIG_OPTION_DELAY_MS: "500",
        }),
      );
      yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel me before the prompt",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("omp"),
            model: "anthropic/claude-opus-4-6",
          },
        })
        .pipe(Effect.forkChild);

      // Wait until sendTurn's config write is in flight: the mock logs the
      // request on receipt, then delays its response by 500ms (real time),
      // so interruptTurn is guaranteed to land inside the prepare phase.
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
          if (requests.some((entry) => entry.method === "session/set_config_option")) {
            return;
          }
          yield* Effect.sleep("25 millis");
        }
        throw new Error("Timed out waiting for the config write to be in flight.");
      });

      yield* adapter.interruptTurn(threadId);
      // Cancellation during preparation resolves sendTurn normally instead of
      // surfacing an error.
      yield* Fiber.join(sendTurnFiber);

      const threadEvents = runtimeEvents.filter(
        (event) => String(event.threadId) === String(threadId),
      );
      const turnCompleted = threadEvents.find((event) => event.type === "turn.completed");
      assert.isDefined(turnCompleted);
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "cancelled");
      }

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.equal(
        requests.filter((entry) => entry.method === "session/prompt").length,
        0,
        "cancelled-before-prompt turn must never reach session/prompt",
      );

      yield* adapter.stopSession(threadId);
      // Live clock so the polling above advances against the mock's real-time
      // set_config_option delay.
    }).pipe(TestClock.withLive),
  );

  it.effect("ignores interrupt requests for turns that are no longer active", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-stale-interrupt");
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      // Keep the prompt in flight long enough for the stale interrupt to land.
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_PROMPT_DELAY_MS: "1500" }),
      );
      yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "keep running", attachments: [] })
        .pipe(Effect.forkChild);

      // Wait until the turn is active, then interrupt with a turn id that
      // does not match — a late cancel for a long-finished turn.
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const sessions = yield* adapter.listSessions();
          const session = sessions.find((entry) => entry.threadId === threadId);
          if (session?.activeTurnId !== undefined) {
            return;
          }
          yield* TestClock.adjust("10 millis");
        }
        throw new Error("Timed out waiting for the turn to become active.");
      });

      yield* adapter.interruptTurn(threadId, TurnId.make("omp-stale-turn-id"));
      yield* Fiber.join(sendTurnFiber);

      const threadEvents = runtimeEvents.filter(
        (event) => String(event.threadId) === String(threadId),
      );
      const turnCompleted = threadEvents.find((event) => event.type === "turn.completed");
      assert.isDefined(turnCompleted);
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "completed");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "settles a steering turn cancelled during preparation exactly once across concurrent prompts",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OmpAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("omp-steering-prepare-cancel");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const argvLogPath = NodePath.join(tempDir, "argv.txt");
        yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
        // Slow set_config_option responses keep both prompts in the prepare
        // phase until the interrupt lands.
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath, {
            T3_ACP_SET_CONFIG_OPTION_DELAY_MS: "500",
          }),
        );
        yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const firstTurnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "first prompt",
            attachments: [],
            modelSelection: {
              instanceId: ProviderInstanceId.make("omp"),
              model: "anthropic/claude-opus-4-6",
            },
          })
          .pipe(Effect.forkChild);

        const waitForConfigWrites = (count: number) =>
          Effect.gen(function* () {
            for (let attempt = 0; attempt < 200; attempt += 1) {
              const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
              if (
                requests.filter((entry) => entry.method === "session/set_config_option").length >=
                count
              ) {
                return;
              }
              yield* Effect.sleep("25 millis");
            }
            throw new Error(`Timed out waiting for ${count} config writes.`);
          });

        yield* waitForConfigWrites(1);

        // Second prompt steers onto the same (still preparing) turn. It must
        // select a model different from the mock's current one, otherwise
        // set_config_option dedupes it and no second config write appears.
        const secondTurnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "second prompt",
            attachments: [],
            modelSelection: {
              instanceId: ProviderInstanceId.make("omp"),
              model: "openai/gpt-5.4",
            },
          })
          .pipe(Effect.forkChild);

        yield* waitForConfigWrites(2);
        yield* adapter.interruptTurn(threadId);

        const firstTurn = yield* Fiber.join(firstTurnFiber);
        const secondTurn = yield* Fiber.join(secondTurnFiber);
        assert.equal(String(firstTurn.turnId), String(secondTurn.turnId));

        const threadEvents = runtimeEvents.filter(
          (event) => String(event.threadId) === String(threadId),
        );
        const turnCompletedEvents = threadEvents.filter((event) => event.type === "turn.completed");
        assert.lengthOf(turnCompletedEvents, 1, "cancelled turn settles exactly once");
        if (turnCompletedEvents[0]?.type === "turn.completed") {
          assert.equal(turnCompletedEvents[0].payload.state, "cancelled");
          assert.equal(String(turnCompletedEvents[0].turnId), String(firstTurn.turnId));
        }

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        assert.equal(
          requests.filter((entry) => entry.method === "session/prompt").length,
          0,
          "cancelled-during-prepare turn must never reach session/prompt",
        );

        yield* adapter.stopSession(threadId);
        // Live clock so the polling above advances against the mock's
        // real-time set_config_option delay.
      }).pipe(TestClock.withLive),
  );

  it.effect("answers permission requests with the option ids the agent advertised", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-permission-option-ids");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      // omp advertises snake_case option ids; the adapter must echo the
      // advertised id, not a hardcoded hyphenated one.
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, {
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_PERMISSION_REQUEST_COUNT: "2",
          T3_ACP_ALLOW_ONCE_OPTION_ID: "allow_once",
          T3_ACP_ALLOW_ALWAYS_OPTION_ID: "allow_always",
          T3_ACP_REJECT_ONCE_OPTION_ID: "reject_once",
        }),
      );
      yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      let openedCount = 0;
      const turnSettled = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "request.opened" && event.requestId) {
            openedCount += 1;
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              openedCount === 1 ? "accept" : "acceptForSession",
            );
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnSettled, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "run two tool calls",
        attachments: [],
      });
      yield* Deferred.await(turnSettled);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const selectedOptionIds = requests.flatMap((entry) => {
        if ("method" in entry) {
          return [];
        }
        const result = entry.result as
          | { outcome?: { outcome?: string; optionId?: unknown } }
          | undefined;
        return result?.outcome?.outcome === "selected" &&
          typeof result.outcome.optionId === "string"
          ? [result.outcome.optionId]
          : [];
      });
      assert.deepStrictEqual(selectedOptionIds, ["allow_once", "allow_always"]);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not settle a cancelled turn after the session was stopped", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-cancel-after-stop");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, {
          T3_ACP_SET_CONFIG_OPTION_DELAY_MS: "500",
        }),
      );
      yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel me, then stop the session",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("omp"),
            model: "anthropic/claude-opus-4-6",
          },
        })
        .pipe(Effect.forkChild);

      // Wait for the config write to be in flight, then interrupt (marks the
      // turn) and stop the session before the write resolves. Stopping kills
      // the ACP child, so the in-flight request fails — both the failure and
      // the deferred cancel settle must stay silent on the dead session.
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
          if (requests.some((entry) => entry.method === "session/set_config_option")) {
            return;
          }
          yield* Effect.sleep("25 millis");
        }
        throw new Error("Timed out waiting for the config write to be in flight.");
      });

      yield* adapter.interruptTurn(threadId);
      yield* adapter.stopSession(threadId);
      // The sendTurn fiber fails with the transport error from the killed
      // child; that propagation is intentional.
      const sendExit = yield* Fiber.await(sendTurnFiber);
      assert.isTrue(Exit.isFailure(sendExit));
      // Let the PubSub consumer drain before reading the collected events.
      yield* Effect.sleep("50 millis");

      const threadEvents = runtimeEvents.filter(
        (event) => String(event.threadId) === String(threadId),
      );
      assert.isTrue(
        threadEvents.some((event) => event.type === "session.exited"),
        "session.exited should be emitted",
      );
      assert.equal(
        threadEvents.filter((event) => event.type === "turn.completed").length,
        0,
        "no turn.completed may be published for a turn whose session was stopped",
      );
      // Live clock so the polling above advances against the mock's
      // real-time set_config_option delay.
    }).pipe(TestClock.withLive),
  );

  it.effect("broadcasts runtime events to multiple stream consumers", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-runtime-event-broadcast");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      const firstConsumer = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const secondConsumer = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      const firstEvents = Array.from(yield* Fiber.join(firstConsumer));
      const secondEvents = Array.from(yield* Fiber.join(secondConsumer));

      assert.deepStrictEqual(
        firstEvents.map((event) => event.type),
        ["session.started", "session.state.changed", "thread.started"],
      );
      assert.deepStrictEqual(
        secondEvents.map((event) => event.type),
        ["session.started", "session.state.changed", "thread.started"],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("switches model in-session via session/set_config_option without respawning", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-model-switch");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });

      yield* adapter.sendTurn({
        threadId,
        input: "second turn after switching model",
        attachments: [],
        modelSelection: createModelSelection(
          ProviderInstanceId.make("omp"),
          "anthropic/claude-opus-4-6",
          [{ id: "reasoning", value: "low" }],
        ),
      });

      // full-access is a spawn-time approval flag for omp; switching models
      // must not restart the session.
      const argvRuns = yield* Effect.promise(() => readArgvLog(argvLogPath));
      assert.lengthOf(argvRuns, 1, "session should not restart — only one spawn");
      assert.deepStrictEqual(argvRuns[0], ["acp", "--approval-mode=yolo"]);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modelConfigRequests = requests.filter(
        (entry) =>
          entry.method === "session/set_config_option" &&
          (entry.params as Record<string, unknown> | undefined)?.configId === "model",
      );
      assert.isAbove(modelConfigRequests.length, 1, "should set the model per turn");
      const lastModelConfig = modelConfigRequests[modelConfigRequests.length - 1];
      assert.equal(
        (lastModelConfig?.params as Record<string, unknown>)?.value,
        "anthropic/claude-opus-4-6",
      );

      const thinkingConfigRequests = requests.filter(
        (entry) =>
          entry.method === "session/set_config_option" &&
          (entry.params as Record<string, unknown> | undefined)?.configId === "thinking",
      );
      assert.isAbove(thinkingConfigRequests.length, 0, "should apply reasoning as thinking");
      const lastThinkingConfig = thinkingConfigRequests[thinkingConfigRequests.length - 1];
      assert.equal((lastThinkingConfig?.params as Record<string, unknown>)?.value, "low");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("clears prior thinking in-session when the next turn lowers reasoning", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-thinking-reset");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn with max thinking",
        attachments: [],
        modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "openai/gpt-5.4", [
          { id: "reasoning", value: "max" },
        ]),
      });

      yield* adapter.sendTurn({
        threadId,
        input: "second turn with low thinking",
        attachments: [],
        modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "openai/gpt-5.4", [
          { id: "reasoning", value: "low" },
        ]),
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const thinkingConfigRequests = requests.filter(
        (entry) =>
          entry.method === "session/set_config_option" &&
          (entry.params as Record<string, unknown> | undefined)?.configId === "thinking",
      );
      assert.isAtLeast(thinkingConfigRequests.length, 2, "should set thinking up and then down");

      const lastThinkingConfig = thinkingConfigRequests[thinkingConfigRequests.length - 1];
      assert.equal((lastThinkingConfig?.params as Record<string, unknown>)?.value, "low");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "applies reasoning on the first turn when modelSelection uses a non-default instance id",
    () => {
      const customInstanceId = ProviderInstanceId.make("omp_secondary");
      // Custom-instance cases can't share the suite-level `OmpAdapter`
      // layer because that one binds `instanceId: "omp"`. We build a
      // fresh layer graph — including a fresh `ServerSettingsService` — so
      // mid-test `updateSettings` calls target the same service instance the
      // adapter's `resolveSettings` reads from, and so the outer
      // `yield* ServerSettingsService` sees the same snapshot as well.
      const customAdapterLayer = makeOmpAdapterTestLayer(customInstanceId);

      return Effect.gen(function* () {
        const adapter = yield* OmpAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("omp-reasoning-custom-instance");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const argvLogPath = NodePath.join(tempDir, "argv.txt");
        yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath),
        );
        yield* serverSettings.updateSettings({
          providers: { omp: { binaryPath: wrapperPath } },
        });

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: customInstanceId,
            model: "openai/gpt-5.4",
          },
        });

        yield* adapter.sendTurn({
          threadId,
          input: "first turn with max thinking",
          attachments: [],
          modelSelection: {
            ...createModelSelection(ProviderInstanceId.make("omp"), "openai/gpt-5.4", [
              { id: "reasoning", value: "max" },
            ]),
            instanceId: customInstanceId,
          },
        });

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const thinkingConfigRequests = requests.filter(
          (entry) =>
            entry.method === "session/set_config_option" &&
            (entry.params as Record<string, unknown> | undefined)?.configId === "thinking",
        );
        assert.isAbove(
          thinkingConfigRequests.length,
          0,
          "reasoning should apply when instance id matches the adapter binding",
        );
        const lastThinkingConfig = thinkingConfigRequests[thinkingConfigRequests.length - 1];
        assert.equal((lastThinkingConfig?.params as Record<string, unknown>)?.value, "max");

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.provide(customAdapterLayer));
    },
  );

  it.effect("projects a single omp task tool call into Agents-panel task events", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-task-tool-single");
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const taskCompleted = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TASK_TOOL: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) === String(threadId) && event.type === "task.completed") {
            yield* Deferred.succeed(taskCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "spawn a subagent",
        attachments: [],
      });
      yield* Deferred.await(taskCompleted);

      const threadEvents = runtimeEvents.filter(
        (event) => String(event.threadId) === String(threadId),
      );
      const taskStarted = threadEvents.find((event) => event.type === "task.started");
      assert.isDefined(taskStarted);
      if (taskStarted?.type === "task.started") {
        assert.equal(String(taskStarted.payload.taskId), "task-tool-call-1");
        assert.equal(taskStarted.payload.taskType, "subagent");
        assert.equal(taskStarted.payload.title, "Implement the feature");
        assert.equal(taskStarted.payload.role, "worker");
        assert.equal(taskStarted.payload.effort, "high");
        assert.equal(taskStarted.payload.toolUseId, "task-tool-call-1");
      }

      const completed = threadEvents.find((event) => event.type === "task.completed");
      assert.isDefined(completed);
      if (completed?.type === "task.completed") {
        assert.equal(String(completed.payload.taskId), "task-tool-call-1");
        assert.equal(completed.payload.status, "completed");
        assert.equal(completed.payload.summary, "subagent finished the work");
        assert.equal(completed.payload.taskType, "subagent");
        assert.equal(completed.payload.role, "worker");
        assert.equal(completed.payload.toolUseId, "task-tool-call-1");
      }

      // The task tool call still shows up as an ordinary tool row in the
      // timeline, mirroring how Claude's Task tool is displayed.
      assert.isTrue(
        threadEvents.some(
          (event) =>
            (event.type === "item.updated" || event.type === "item.completed") &&
            String(event.itemId) === "task-tool-call-1",
        ),
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("projects a batch omp task tool call into one task per item", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-task-tool-batch");
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const allTasksCompleted = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TASK_TOOL_BATCH: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          const completedCount = runtimeEvents.filter(
            (entry) =>
              String(entry.threadId) === String(threadId) && entry.type === "task.completed",
          ).length;
          if (completedCount >= 2) {
            yield* Deferred.succeed(allTasksCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "spawn two subagents",
        attachments: [],
      });
      yield* Deferred.await(allTasksCompleted);

      const threadEvents = runtimeEvents.filter(
        (event) => String(event.threadId) === String(threadId),
      );
      const starts = threadEvents.filter((event) => event.type === "task.started");
      assert.lengthOf(starts, 2);
      const startsByTaskId = new Map(
        starts.flatMap((event) =>
          event.type === "task.started"
            ? [[String(event.payload.taskId), event.payload] as const]
            : [],
        ),
      );
      assert.deepInclude(startsByTaskId.get("task-tool-call-1:0"), {
        taskType: "subagent",
        title: "Research the codebase layout",
        role: "scout",
        effort: "low",
        toolUseId: "task-tool-call-1",
      });
      assert.deepInclude(startsByTaskId.get("task-tool-call-1:1"), {
        taskType: "subagent",
        title: "Implement the feature",
        role: "worker",
        effort: "high",
        toolUseId: "task-tool-call-1",
      });

      const completions = threadEvents.filter((event) => event.type === "task.completed");
      assert.lengthOf(completions, 2);
      for (const completion of completions) {
        if (completion.type !== "task.completed") {
          continue;
        }
        assert.equal(completion.payload.status, "completed");
        assert.equal(completion.payload.taskType, "subagent");
        assert.equal(completion.payload.toolUseId, "task-tool-call-1");
      }
      assert.deepEqual(
        completions.map((event) =>
          event.type === "task.completed" ? String(event.payload.taskId) : "",
        ),
        ["task-tool-call-1:0", "task-tool-call-1:1"],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("marks the omp task failed when the task tool call fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-task-tool-failed");
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const taskCompleted = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TASK_TOOL_FAIL: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) === String(threadId) && event.type === "task.completed") {
            yield* Deferred.succeed(taskCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "spawn a failing subagent",
        attachments: [],
      });
      yield* Deferred.await(taskCompleted);

      const completed = runtimeEvents.find(
        (event) => String(event.threadId) === String(threadId) && event.type === "task.completed",
      );
      assert.isDefined(completed);
      if (completed?.type === "task.completed") {
        assert.equal(String(completed.payload.taskId), "task-tool-call-1");
        assert.equal(completed.payload.status, "failed");
        assert.equal(completed.payload.summary, "subagent failed to finish");
        assert.equal(completed.payload.taskType, "subagent");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  // Production calls startSession from a request fiber that finishes as soon as
  // the session exists. `Effect.forkChild` made the notification consumer a
  // child of that fiber, and Effect interrupts a fiber's children when it
  // completes, so the consumer died on return and every later session/update
  // was dropped: the thread sat on "Working" forever while the provider
  // streamed its whole turn. The other tests here call startSession directly
  // from the test fiber, which never completes, so the consumer survived and
  // the bug stayed invisible. Running it in a fiber that finishes is what
  // reproduces production.
  it.effect("keeps consuming notifications after the startSession fiber completes", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("omp-consumer-outlives-start-session");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { omp: { binaryPath: wrapperPath } } });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const sawContentDelta = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "content.delta" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(sawContentDelta, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const startSessionFiber = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.4" },
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startSessionFiber).pipe(Effect.timeout("10 seconds"));

      // Forked, and the assertion waits on the projected event rather than on
      // sendTurn: with the consumer dead the turn never settles, so awaiting it
      // directly would hang until the suite timeout instead of failing here.
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hello mock", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(sawContentDelta).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("10 seconds"));

      const delta = runtimeEvents.find(
        (event) => event.type === "content.delta" && String(event.threadId) === String(threadId),
      );
      assert.isDefined(
        delta,
        "no content.delta was projected after the startSession fiber completed",
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
      // Live clock so the timeouts above are real: under the default test clock
      // they wait on virtual time that never advances, and a regression would
      // hang until the suite timeout instead of failing here.
    }).pipe(TestClock.withLive),
  );
});
