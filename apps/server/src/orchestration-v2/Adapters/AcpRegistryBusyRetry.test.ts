import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { AcpPromptBusyRetryPolicy } from "@t3tools/provider-acp/server/promptBusyRetry";
import { minimaxCodePromptBusyRetry } from "@t3tools/provider-acp-registry/server/minimaxCodeAcp";
import { ACP_REGISTRY_PROVIDER } from "@t3tools/provider-acp-registry/testing";
import {
  makeProviderReplayGate,
  type ProviderReplayGate,
} from "@t3tools/provider-testing/replayGate";

import { decodeAcpReplayTranscript, makeAcpReplayRuntime } from "./AcpAdapterV2.testkit.ts";

const layerTest = Layer.mergeAll(NodeServices.layer, Layer.empty);

const MINIMAX_SESSION = "minimax-session";

/** The turn lease rejection minimax-code answers with while it unwinds a turn. */
const MINIMAX_CODE_BUSY_MESSAGE =
  "MiniMax Code Runtime failed: Session already has an active Turn. Use queue send to deliver the message after it.";

// Zero delay keeps replay independent of the test clock.
const busyRetryPolicy: AcpPromptBusyRetryPolicy = {
  ...minimaxCodePromptBusyRetry,
  delayMs: () => 0,
};

const minimaxCodeFrames = {
  open: [
    { type: "expect_outbound", frame: { kind: "request", method: "initialize", params: "<any>" } },
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "initialize",
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
          authMethods: [],
        },
      },
    },
    { type: "expect_outbound", frame: { kind: "request", method: "session/new", params: "<any>" } },
    {
      type: "emit_inbound",
      frame: { kind: "response", method: "session/new", result: { sessionId: MINIMAX_SESSION } },
    },
  ],
  promptRequest: {
    type: "expect_outbound",
    frame: { kind: "request", method: "session/prompt", params: "<any>" },
  },
  busyPrompt: {
    type: "emit_inbound",
    label: "busy",
    frame: {
      kind: "response",
      method: "session/prompt",
      error: { code: -32603, message: MINIMAX_CODE_BUSY_MESSAGE },
    },
  },
  busyPromptImmediate: {
    type: "emit_inbound",
    frame: {
      kind: "response",
      method: "session/prompt",
      error: { code: -32603, message: MINIMAX_CODE_BUSY_MESSAGE },
    },
  },
  acceptedPrompt: {
    type: "emit_inbound",
    frame: { kind: "response", method: "session/prompt", result: { stopReason: "end_turn" } },
  },
  cancelNotification: {
    type: "expect_outbound",
    frame: { kind: "notification", method: "session/cancel", params: "<any>" },
  },
  /**
   * The agent only sends this once it consumed the cancel notification, so a
   * test that waits for it knows the agent saw the whole transcript.
   */
  cancelConsumedMarker: {
    type: "emit_inbound",
    label: "cancel-consumed",
    frame: {
      kind: "notification",
      method: "session/update",
      params: {
        sessionId: MINIMAX_SESSION,
        update: { sessionUpdate: "session_info_update", title: "cancel consumed" },
      },
    },
  },
  /**
   * The agent only sends this once it received the re-sent prompt, so a test
   * that waits for it knows the re-send is with the agent.
   */
  reSendMarker: {
    type: "emit_inbound",
    label: "re-sent",
    frame: {
      kind: "notification",
      method: "session/update",
      params: {
        sessionId: MINIMAX_SESSION,
        update: { sessionUpdate: "session_info_update", title: "prompt re-sent" },
      },
    },
  },
};

interface ReplayStatus {
  readonly cursor: number;
  readonly total: number;
  readonly failure?: unknown;
}

const openMinimaxCodeRuntime = Effect.fn("openMinimaxCodeRuntime")(function* (
  entries: ReadonlyArray<unknown>,
  replayGate?: ProviderReplayGate,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const replayDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-minimax-busy-retry-" });
  const statusPath = path.join(replayDir, "status.json");
  const transcript = yield* decodeAcpReplayTranscript(
    {
      provider: ACP_REGISTRY_PROVIDER,
      protocol: "acp.ndjson-jsonrpc",
      version: "1",
      scenario: "minimax-busy-retry",
      entries: entries as never,
    },
    ACP_REGISTRY_PROVIDER,
  );
  const runtime = yield* makeAcpReplayRuntime({
    transcript,
    statusPath,
    scriptPath: yield* path.fromFileUrl(
      new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
    ),
    childProcessSpawner,
    fileSystem,
    ...(replayGate === undefined ? {} : { replayGate }),
  })({
    cwd: replayDir,
    runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "approval-required",
      interactionMode: "default",
      cwd: replayDir,
    }),
    mcpServers: [],
    // minimax-code does not interrupt the local prompt fiber on a cancel, so
    // the runtime has to keep the prompt from being re-sent on its own.
    interruptPromptOnCancel: false,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      elicitation: { form: {} },
    },
    clientInfo: { name: "t3-code", version: "0.0.0" },
    protocolLogging: { logIncoming: false, logOutgoing: false, logger: () => Effect.void },
    onTermination: () => Effect.void,
    promptBusyRetry: busyRetryPolicy,
  });
  yield* runtime.start();
  const readStatus = Effect.fn("readStatus")(function* () {
    const raw = yield* fileSystem.readFileString(statusPath);
    return JSON.parse(raw) as ReplayStatus;
  });
  return { runtime, readStatus };
});

describe("minimax-code busy turn lease", () => {
  it.effect("re-sends a prompt the agent rejected as busy", () =>
    Effect.gen(function* () {
      const { runtime, readStatus } = yield* openMinimaxCodeRuntime([
        ...minimaxCodeFrames.open,
        minimaxCodeFrames.promptRequest,
        minimaxCodeFrames.busyPrompt,
        minimaxCodeFrames.promptRequest,
        minimaxCodeFrames.acceptedPrompt,
      ]);

      const response = yield* runtime.prompt({ prompt: [{ type: "text", text: "hello" }] });

      assert.equal(response.stopReason, "end_turn");
      // The transcript only accepts a second session/prompt, so a runtime
      // that did not re-send leaves the replay agent with a pending frame.
      const status = yield* readStatus();
      assert.isUndefined(status.failure);
      assert.equal(status.cursor, status.total);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("does not re-send a prompt that was cancelled", () =>
    Effect.gen(function* () {
      const gate = makeProviderReplayGate(["busy", "cancel-consumed"]);
      const { runtime, readStatus } = yield* openMinimaxCodeRuntime(
        [
          ...minimaxCodeFrames.open,
          minimaxCodeFrames.promptRequest,
          minimaxCodeFrames.busyPrompt,
          minimaxCodeFrames.cancelNotification,
          minimaxCodeFrames.cancelConsumedMarker,
        ],
        gate,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.release("busy")));

      const prompt = yield* Effect.forkChild(
        runtime.prompt({ prompt: [{ type: "text", text: "hello" }] }),
      );
      // The agent has the prompt and is holding its busy rejection.
      assert.isTrue(yield* Effect.promise(() => gate.waitForReached("busy")));

      // The user stops the turn while the prompt is still in flight, so the
      // agent rejects it as busy only after the turn was cancelled.
      yield* runtime.cancel;
      gate.release("busy");

      const response = yield* Fiber.join(prompt);
      assert.equal(response.stopReason, "cancelled");

      // The agent consumed the cancel, so it also consumed the whole
      // transcript. A second session/prompt would have failed the replay
      // agent instead of completing the transcript.
      assert.isTrue(yield* Effect.promise(() => gate.waitForReached("cancel-consumed")));
      const status = yield* readStatus();
      assert.isUndefined(status.failure);
      assert.equal(status.cursor, status.total);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("cancels a re-sent prompt the agent already accepted", () =>
    Effect.gen(function* () {
      const gate = makeProviderReplayGate(["re-sent", "accepted"]);
      const { runtime } = yield* openMinimaxCodeRuntime(
        [
          ...minimaxCodeFrames.open,
          minimaxCodeFrames.promptRequest,
          minimaxCodeFrames.busyPromptImmediate,
          minimaxCodeFrames.promptRequest,
          minimaxCodeFrames.reSendMarker,
          minimaxCodeFrames.cancelNotification,
          { ...minimaxCodeFrames.acceptedPrompt, label: "accepted" },
        ],
        gate,
      );

      const prompt = yield* Effect.forkChild(
        runtime.prompt({ prompt: [{ type: "text", text: "hello" }] }),
      );
      // The agent received the re-sent prompt and is holding its response.
      assert.isTrue(yield* Effect.promise(() => gate.waitForReached("re-sent")));

      yield* runtime.cancel;

      // The agent's response never arrives, so the turn can only settle if
      // the cancel stopped the re-sent prompt on its own. Otherwise the
      // prompt would wait for a response that is never delivered.
      const response = yield* Fiber.join(prompt);
      assert.equal(response.stopReason, "cancelled");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
