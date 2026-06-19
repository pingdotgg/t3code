// @effect-diagnostics nodeBuiltinImport:off
import * as path from "node:path";
import * as os from "node:os";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ApprovalRequestId,
  GrokBuildSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  buildGrokBuildPromptBlocks,
  makeGrokBuildAdapter,
  resolveGrokBuildAcpBaseModelId,
} from "./GrokBuildAdapter.ts";

const decodeGrokBuildSettings = Schema.decodeSync(GrokBuildSettings);

class GrokBuildAdapter extends Context.Service<
  GrokBuildAdapter,
  ProviderAdapterShape<ProviderAdapterError>
>()("t3/provider/Layers/GrokBuildAdapter.test/GrokBuildAdapter") {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = "node";
const mockAgentArgs = [mockAgentPath] as const;

async function makeMockAgentWrapper(extraEnv?: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-acp-mock-"));
  const wrapperPath = path.join(dir, "fake-grok.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${mockAgentArgs.map((arg) => JSON.stringify(arg)).join(" ")} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function waitForFileContent(filePath: string, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const raw = await readFile(filePath, "utf8");
      if (raw.trim().length > 0) {
        return raw;
      }
    } catch {}
    await Effect.runPromise(Effect.yieldNow);
  }
  throw new Error(`Timed out waiting for file content at ${filePath}`);
}

describe("GrokBuildAdapter helpers", () => {
  it("maps user-facing model aliases to Grok ACP model ids", () => {
    expect(resolveGrokBuildAcpBaseModelId(undefined)).toBe("grok-build");
    expect(resolveGrokBuildAcpBaseModelId("composer-2.5")).toBe("grok-composer-2.5-fast");
    expect(resolveGrokBuildAcpBaseModelId("custom-model")).toBe("custom-model");
  });

  it("builds ACP prompt blocks from optional text and attachments", () => {
    const imageBlock = {
      type: "image",
      data: "base64-image",
      mimeType: "image/png",
    } satisfies EffectAcpSchema.ContentBlock;

    expect(
      buildGrokBuildPromptBlocks({
        text: "  inspect this  ",
        attachmentBlocks: [imageBlock],
      }),
    ).toEqual([{ type: "text", text: "inspect this" }, imageBlock]);

    expect(
      buildGrokBuildPromptBlocks({
        text: "   ",
        attachmentBlocks: [imageBlock],
      }),
    ).toEqual([imageBlock]);

    expect(
      buildGrokBuildPromptBlocks({
        text: undefined,
        attachmentBlocks: [],
      }),
    ).toEqual([]);
  });
});

const grokAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

grokAdapterTestLayer("GrokBuildAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-mock-thread");

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
      });

      assert.equal(session.provider, "grok-build");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const runtimeEvents = Array.from(
        yield* Fiber.join(runtimeEventsFiber),
      ) as ReadonlyArray<ProviderRuntimeEvent>;
      const types = runtimeEvents.map((event) => event.type);

      for (const expectedType of [
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
        assert.include(types, expectedType);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes a session when a resume cursor is provided", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-resume-thread");

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
        resumeCursor: {
          schemaVersion: 1,
          sessionId: "mock-session-1",
        },
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "resume check",
        attachments: [],
      });
      assert.deepStrictEqual(turn.resumeCursor, session.resumeCursor);

      yield* adapter.stopSession(threadId);
    }),
  );
});

const grokPermissionAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-permission-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

grokPermissionAdapterTestLayer("GrokBuildAdapter permissions", (it) => {
  it.effect("handles permission requests and cancellation", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-permission-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
      });

      const requestOpenedFiber = yield* Stream.take(adapter.streamEvents, 20).pipe(
        Stream.filter((event) => event.type === "request.opened"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.sendTurn({
        threadId,
        input: "trigger permission",
        attachments: [],
      });

      const openedEvents = Array.from(yield* Fiber.join(requestOpenedFiber));
      const opened = openedEvents[0];
      assert.isDefined(opened);
      if (opened?.type === "request.opened" && opened.requestId) {
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(String(opened.requestId)),
          "accept",
        );
      }

      yield* adapter.interruptTurn(threadId);
      yield* adapter.stopSession(threadId);
    }),
  );
});

const grokStopTestState: { exitLogPath?: string } = {};

const grokStopAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "grok-adapter-exit-log-")),
      );
      grokStopTestState.exitLogPath = path.join(tempDir, "exit.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EXIT_LOG_PATH: grokStopTestState.exitLogPath! }),
      );
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-stop-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const grokThreadAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-thread-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

grokThreadAdapterTestLayer("GrokBuildAdapter thread snapshot", (it) => {
  it.effect("records turns for readThread and rollbackThread", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-thread-snapshot");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
      });

      const forkTurnCompletedWaiter = (count: number) =>
        Stream.take(adapter.streamEvents, 30).pipe(
          Stream.filter(
            (event) =>
              event.type === "turn.completed" && String(event.threadId) === String(threadId),
          ),
          Stream.take(count),
          Stream.runDrain,
          Effect.forkChild,
        );

      const firstTurnCompleted = yield* forkTurnCompletedWaiter(1);
      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      yield* Fiber.join(firstTurnCompleted);

      const secondTurnCompleted = yield* forkTurnCompletedWaiter(1);
      yield* adapter.sendTurn({
        threadId,
        input: "second turn",
        attachments: [],
      });
      yield* Fiber.join(secondTurnCompleted);

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.turns.length, 2);

      const rolledBack = yield* adapter.rollbackThread(threadId, 1);
      assert.equal(rolledBack.turns.length, 1);
      assert.equal((yield* adapter.readThread(threadId)).turns.length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );
});

const grokUserInputAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_ASK_QUESTION: "1" }),
      );
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-user-input-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

grokUserInputAdapterTestLayer("GrokBuildAdapter user input", (it) => {
  it.effect("handles ask-question requests and user responses", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-user-input-thread");
      const userInputRequested = yield* Deferred.make<ApprovalRequestId>();

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId) || event.type !== "user-input.requested") {
          return Effect.void;
        }
        if (!event.requestId) {
          return Effect.void;
        }
        return Deferred.succeed(
          userInputRequested,
          ApprovalRequestId.make(String(event.requestId)),
        ).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "ask me a question",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const requestId = yield* Deferred.await(userInputRequested);
      yield* adapter.respondToUserInput(threadId, requestId, { scope: "workspace" });

      yield* Fiber.await(sendTurnFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});

grokStopAdapterTestLayer("GrokBuildAdapter shutdown", (it) => {
  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-stop-session-close");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(threadId);

      assert.isDefined(grokStopTestState.exitLogPath);
      const exitLog = yield* Effect.promise(() =>
        waitForFileContent(grokStopTestState.exitLogPath!),
      );
      assert.include(exitLog, "SIGTERM");
    }),
  );
});
