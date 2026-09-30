/**
 * Opt-in check of the Pi adapter against a real `pi` install. The fake Pi in
 * PiAdapter.test.ts cannot catch RPC drift, so run this after a Pi upgrade:
 *
 *   T3_PI_LIVE_MODEL=<provider/model> vp test run PiAdapter.live
 *
 * It uses the user's Pi models and credentials. Sessions go to a temp
 * `--session-dir`, so the user's Pi session history stays untouched.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  type ModelSelection,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { piRecordString } from "../PiRpc.ts";
import { makePiAdapter } from "./PiAdapter.ts";
import { checkPiProviderStatus } from "./PiProvider.ts";

const MODEL = process.env.T3_PI_LIVE_MODEL ?? "";
const PI = ProviderInstanceId.make("pi");
const THREAD_ID = ThreadId.make("thread-pi-live");
const selection: ModelSelection = { instanceId: PI, model: MODEL };

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-live-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const makeLiveHarness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-live-workspace-" });
  const sessionDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-live-sessions-" });
  const settings = {
    enabled: true,
    binaryPath: "pi",
    launchArgs: `--session-dir ${sessionDir}`,
    customModels: [],
  };
  const adapter = yield* makePiAdapter(settings, { instanceId: PI });
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
    Effect.forkScoped,
  );
  yield* Effect.yieldNow;

  /** Sends a turn, accepts every approval, and returns the turn's events and text. */
  const runTurn = (input: string) =>
    Effect.gen(function* () {
      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input,
        modelSelection: selection,
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      while (true) {
        const event = yield* Queue.take(events);
        seen.push(event);
        if (event.type === "request.opened" && event.requestId !== undefined) {
          yield* adapter.respondToRequest(
            THREAD_ID,
            ApprovalRequestId.make(event.requestId),
            "accept",
          );
        }
        if (event.type === "turn.completed" && event.turnId === turn.turnId) break;
      }
      const text = seen
        .flatMap((event) =>
          event.type === "content.delta" && event.payload.streamKind === "assistant_text"
            ? [event.payload.delta]
            : [],
        )
        .join("");
      return { events: seen, text, completed: seen.at(-1) };
    }).pipe(Effect.timeout("3 minutes"));

  const cursor = adapter
    .listSessions()
    .pipe(Effect.map((sessions) => sessions.find((s) => s.threadId === THREAD_ID)?.resumeCursor));

  return { adapter, cwd, settings, runTurn, cursor };
});

describe.runIf(MODEL.length > 0)("PiAdapter against a real Pi", () => {
  it.live(
    "lists the model with its thinking levels",
    () =>
      Effect.gen(function* () {
        const { settings, cwd } = yield* makeLiveHarness;
        const snapshot = yield* checkPiProviderStatus(settings, process.env, cwd);
        assert.equal(snapshot.status, "ready");
        assert.isDefined(snapshot.models.find((model) => model.slug === MODEL));
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    60_000,
  );

  it.live(
    "runs a supervised tool turn, resumes the session, and rolls back a turn",
    () =>
      Effect.gen(function* () {
        const { adapter, cwd, runTurn, cursor } = yield* makeLiveHarness;
        yield* adapter.startSession({ threadId: THREAD_ID, cwd, runtimeMode: "approval-required" });

        const tool = yield* runTurn("Run `echo t3-live-ok` with bash, then reply with its output.");
        assert.deepInclude(tool.completed?.payload, { state: "completed" });
        assert.isTrue(tool.events.some((event) => event.type === "request.opened"));
        const bash = tool.events.find(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "command_execution",
        );
        const bashData = bash?.type === "item.completed" ? bash.payload.data : undefined;
        assert.include(piRecordString(bashData, "result") ?? "", "t3-live-ok");

        yield* runTurn("Remember the code word PINEAPPLE-42. Reply with exactly: OK");
        const saved = yield* cursor;
        yield* adapter.stopSession(THREAD_ID);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          cwd,
          runtimeMode: "approval-required",
          resumeCursor: saved,
        });
        const resumed = yield* runTurn("What code word did I give you? Reply with only the word.");
        assert.include(resumed.text, "PINEAPPLE-42");

        yield* runTurn("A second code word is MANGO-7. Reply with exactly: OK");
        yield* adapter.rollbackThread(THREAD_ID, 1);
        const afterRollback = yield* runTurn(
          "List every code word I gave you, comma separated, and nothing else.",
        );
        assert.include(afterRollback.text, "PINEAPPLE-42");
        assert.notInclude(afterRollback.text, "MANGO-7");
        yield* adapter.stopSession(THREAD_ID);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    600_000,
  );
});
