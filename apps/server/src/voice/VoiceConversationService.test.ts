import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type VoiceConversationOptions,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { splitSentences } from "../speech/sentences.ts";
import * as SpeechService from "../speech/SpeechService.ts";
import * as TextToSpeech from "../speech/TextToSpeech.ts";
import * as FrontModel from "./FrontModel.ts";
import type { VoiceCallOutput } from "./speaker.ts";
import * as VoiceConversationService from "./VoiceConversationService.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const CHUNK = 8000;

type Held = { stt: number; tts: number; front: number };

/**
 * A call on a real orchestrator whose agent answers every turn with the next scripted
 * reply. Speech recognition, the voice and the front model are fakes the test drives.
 */
const harness = Effect.fn("test.voiceCall.harness")(function* (name: string, replies: string[]) {
  const cwd = yield* checkpointWorkspace(`voice-call-${name}`);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const prompts: string[] = [];
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              prompts.push(turn.message.text);
              const at = yield* DateTime.now;
              const providerTurn = {
                id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: at,
                completedAt: null,
              } as const;
              yield* Queue.offerAll(events, [
                { type: "provider_turn.updated", driver, providerTurn },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: TurnItemId.make(`answer:${turn.attemptId}`),
                    threadId: turn.threadId,
                    runId: turn.runId,
                    nodeId: turn.rootNodeId,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId: providerTurn.id,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 0,
                    status: "completed",
                    title: null,
                    startedAt: at,
                    completedAt: at,
                    updatedAt: at,
                    type: "assistant_message",
                    messageId: MessageId.make(`message:answer:${turn.attemptId}`),
                    text: replies.shift() ?? "Done.",
                    streaming: false,
                  },
                },
                {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: { ...providerTurn, status: "completed", completedAt: at },
                },
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId: providerTurn.id,
                  runOrdinal: turn.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          compactThread: () => Effect.die("unused"),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: `voice-call-${name}` },
    ProviderAdapterRegistry.layerSingle(adapter),
  );
  const layerThreads = Layer.merge(
    layerOrchestrator,
    ThreadManagementService.layer.pipe(
      Layer.provide(layerOrchestrator),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    ),
  );

  const held: Held = { stt: 0, tts: 0, front: 0 };
  const hold = (key: keyof Held) =>
    Effect.acquireRelease(
      Effect.sync(() => void (held[key] += 1)),
      () => Effect.sync(() => void (held[key] -= 1)),
    );
  // Each heard chunk takes the next scripted recognizer state.
  const heard: { text: string; voiced: boolean }[] = [];
  let fed = 0;
  let samples = 0;
  let voicedUntil: number | undefined;
  let text = "";
  const stream: SpeechService.SpeechStream = {
    feed: (pcm) =>
      Effect.sync(() => {
        const next = heard.shift() ?? { text, voiced: false };
        samples += pcm.byteLength / 4;
        if (next.voiced) voicedUntil = samples;
        const changed = next.text !== text;
        text = next.text;
        return {
          revision: ++fed,
          text: changed ? { committed: text, tentative: "" } : null,
          samples,
          ...(voicedUntil === undefined ? {} : { voicedUntil }),
        };
      }),
    finish: Effect.die("unused"),
    next: Effect.sync(() => {
      const utterance = text;
      text = "";
      samples = 0;
      voicedUntil = undefined;
      return utterance;
    }),
  };
  const speech = Layer.succeed(
    SpeechService.SpeechService,
    SpeechService.SpeechService.of({
      status: Effect.die("unused"),
      models: () => Effect.die("unused"),
      downloadModel: () => Effect.die("unused"),
      selectModel: () => Effect.die("unused"),
      cancelDownload: () => Effect.die("unused"),
      removeModel: () => Effect.die("unused"),
      prepareModel: Effect.die("unused"),
      transcribe: () => Effect.die("unused"),
      updateAcceleration: () => Effect.die("unused"),
      updateModelUnloadTimeout: () => Effect.die("unused"),
      startStream: (_options, mode) =>
        mode === "conversation" ? hold("stt").pipe(Effect.as(stream)) : Effect.die("dictation"),
    }),
  );
  // A thousand samples a word, one chunk per sentence.
  const tts = Layer.succeed(
    TextToSpeech.TextToSpeech,
    TextToSpeech.TextToSpeech.of({
      sampleRate: 24_000,
      hold: hold("tts"),
      synthesize: (text) =>
        Stream.fromIterable(splitSentences(text)).pipe(
          Stream.map((sentence) => new Float32Array(sentence.split(" ").length * 1000)),
        ),
    }),
  );
  const decisions = yield* Queue.unbounded<Effect.Effect<FrontModel.FrontDecision>>();
  const asked: (readonly FrontModel.FrontMessage[])[] = [];
  const asking = yield* Queue.unbounded<void>();
  const front = Layer.succeed(
    FrontModel.FrontModel,
    FrontModel.FrontModel.of({
      acquire: hold("front").pipe(
        Effect.as({
          decide: (messages) =>
            Effect.sync(() => void asked.push(messages)).pipe(
              Effect.andThen(Queue.offer(asking, undefined)),
              Effect.andThen(Queue.take(decisions)),
              Effect.flatten,
            ),
        }),
      ),
    }),
  );
  const layer = VoiceConversationService.layer.pipe(
    Layer.provideMerge(layerThreads),
    Layer.provide(Layer.mergeAll(speech, tts, front, NodeServices.layer, NodeCrypto.layer)),
  );

  const threadId = ThreadId.make(`thread:voice-call-${name}`);
  const call = Effect.fn("test.voiceCall.start")(function* (
    options: Partial<VoiceConversationOptions> = {},
  ) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:voice-call-${name}`),
      title: "Voice call",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const outputs = yield* Queue.unbounded<VoiceCallOutput>();
    const service = yield* VoiceConversationService.VoiceConversationService;
    const voice = yield* service.start({
      threadId,
      options: {
        transcription: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        source: "web",
        ...options,
      },
      send: (output) => Queue.offer(outputs, output),
    });
    const seen: VoiceCallOutput[] = [];
    /** Takes outputs up to and including the first that matches. */
    const until = Effect.fn("test.voiceCall.until")(function* (
      match: (output: VoiceCallOutput) => boolean,
    ) {
      const taken: VoiceCallOutput[] = [];
      while (true) {
        const output = yield* Queue.take(outputs);
        seen.push(output);
        taken.push(output);
        if (match(output)) return taken;
      }
    });
    /** Half a second of mic audio the recognizer hears as `words`. */
    const say = Effect.fn("test.voiceCall.say")(function* (words: string, voiced = true) {
      heard.push({ text: words, voiced });
      yield* voice.hear(new Uint8Array(CHUNK * 4));
    });
    const pause = Effect.fn("test.voiceCall.pause")(function* (ms: number) {
      for (let chunk = 0; chunk < ms / 500; chunk++) yield* say(text, false);
    });
    /** Waits until `frames` audio frames of `seq` were sent. */
    const rendered = Effect.fn("test.voiceCall.rendered")(function* (seq: number, frames: number) {
      const count = () =>
        seen.filter((output) => output.type === "audio" && output.seq === seq).length;
      while (count() < frames) yield* until((output) => output.type === "audio");
    });
    return { voice, until, say, pause, seen, rendered, fed: () => fed };
  });
  const decide = (decision: FrontModel.FrontDecision) =>
    Queue.offer(decisions, Effect.succeed(decision));
  return { layer, call, decide, decisions, asked, asking, held, prompts };
});

const isState = (state: string) => (output: VoiceCallOutput) =>
  output.type === "state" && output.state === state;
const spoken = (outputs: readonly VoiceCallOutput[]) =>
  outputs.flatMap((output) => (output.type === "speak" ? [output.text] : []));
const lastUser = (messages: readonly FrontModel.FrontMessage[]) => messages.at(-1)?.content;

it.effect("answers a finished utterance and stays speaking until playback is heard", () =>
  Effect.gen(function* () {
    const test = yield* harness("reply", []);
    yield* Effect.gen(function* () {
      const { voice, until, say, pause, rendered } = yield* test.call();
      yield* until(isState("listening"));
      yield* say("what time");
      yield* say("what time is it");
      yield* test.decide({ action: "reply", speech: "It is noon. Lunch? No. Anything else?" });
      yield* pause(1500);
      const answered = yield* until(isState("speaking"));
      assert.deepStrictEqual(lastUser(test.asked[0]!), "what time is it");
      assert.deepStrictEqual(spoken(answered), ["It is noon. Lunch?"]);
      assert.isTrue(answered.some(isState("thinking")));
      // Rendering ends, but the client still has audio to play.
      yield* rendered(1, 2);
      yield* voice.played(1, 3000);
      const heard = yield* until(
        (output) => output.type === "caption" && output.who === "voice" && output.committed !== "",
      );
      assert.deepStrictEqual(heard.at(-1), {
        type: "caption",
        who: "voice",
        committed: "It is noon.",
        tentative: "Lunch?",
      });
      yield* voice.played(1, 4000);
      yield* until(isState("listening"));
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.scoped),
);

it.effect("cuts the voice when the user talks over it and answers the new words", () =>
  Effect.gen(function* () {
    const test = yield* harness("barge-in", []);
    yield* Effect.gen(function* () {
      const { voice, until, say, pause, rendered } = yield* test.call();
      yield* say("tell me a story");
      yield* test.decide({ action: "reply", speech: "Once upon a time. There was a build." });
      yield* pause(1500);
      yield* rendered(1, 2);
      yield* voice.played(1, 1000);
      yield* say("wait");
      const cut = yield* until((output) => output.type === "cut");
      assert.deepStrictEqual(cut.at(-1), { type: "cut", seq: 1 });
      yield* say("wait stop");
      yield* test.decide({ action: "reply", speech: "Stopped." });
      yield* pause(1500);
      const answered = yield* until((output) => output.type === "speak");
      assert.deepStrictEqual(lastUser(test.asked[1]!), "wait stop");
      assert.deepStrictEqual(spoken(answered), ["Stopped."]);
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.scoped),
);

it.effect("drops an answer still being thought of once the user speaks again", () =>
  Effect.gen(function* () {
    const test = yield* harness("interrupt-thinking", []);
    yield* Effect.gen(function* () {
      const { until, say, pause } = yield* test.call();
      yield* say("open the");
      yield* Queue.offer(test.decisions, Effect.never);
      yield* pause(3000);
      yield* Queue.take(test.asking);
      yield* say("open the readme");
      yield* until(isState("listening"));
      yield* test.decide({ action: "reply", speech: "Opening it." });
      yield* pause(1500);
      yield* until((output) => output.type === "speak");
      // The cut-off sentence and its rest reach the front as one turn.
      assert.deepStrictEqual(lastUser(test.asked[1]!), "open the open the readme");
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.scoped),
);

it.effect("resumes from the cursor after a listening sound and passes it on as a note", () =>
  Effect.gen(function* () {
    const test = yield* harness("backchannel", ["The suite passed."]);
    yield* Effect.gen(function* () {
      const { voice, until, say, pause, rendered } = yield* test.call();
      yield* say("how does the release work");
      yield* test.decide({ action: "reply", speech: "First we tag it. Then we ship it." });
      yield* pause(1500);
      yield* rendered(1, 2);
      yield* voice.played(1, 4000);
      yield* say("mm-hm");
      yield* until((output) => output.type === "cut");
      yield* pause(500);
      const resumed = yield* until((output) => output.type === "speak");
      assert.deepStrictEqual(spoken(resumed), ["Then we ship it."]);
      // A listening sound never reaches the front.
      assert.strictEqual(test.asked.length, 1);

      yield* rendered(2, 1);
      yield* voice.played(2, 4000);
      yield* until(isState("listening"));
      yield* say("run the tests");
      yield* test.decide({ action: "delegate", speech: "On it.", task: "Run the test suite." });
      yield* test.decide({ action: "reply", speech: "All tests pass." });
      yield* pause(1500);
      yield* until((output) => output.type === "speak" && output.text === "All tests pass.");
      assert.deepStrictEqual(test.prompts, [
        'run the tests\n\nVoice assistant\'s reading: Run the test suite.\n\nNotes from the voice call:\n- The user said "mm-hm".',
      ]);
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.scoped),
);

it.effect("lets the voice's own echo through without a cut", () =>
  Effect.gen(function* () {
    const test = yield* harness("echo", []);
    yield* Effect.gen(function* () {
      const { voice, until, say, pause, seen, rendered } = yield* test.call();
      yield* say("status");
      yield* test.decide({ action: "reply", speech: "Running the tests now. Back soon." });
      yield* pause(1500);
      yield* rendered(1, 2);
      yield* voice.played(1, 4000);
      yield* say("the tests now");
      yield* pause(1500);
      yield* voice.played(1, 6000);
      yield* until(isState("listening"));
      assert.isFalse(seen.some((output) => output.type === "cut"));
      assert.strictEqual(test.asked.length, 1);
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.scoped),
);

it.effect("delegates work, follows the run, and reads back a short summary", () =>
  Effect.gen(function* () {
    const test = yield* harness("delegate", ["Fixed the flaky test in auth.test.ts. All 12 pass."]);
    yield* Effect.gen(function* () {
      const { until, say, pause } = yield* test.call();
      yield* say("fix the flaky auth test");
      yield* test.decide({
        action: "delegate",
        speech: "On it.",
        task: "Fix the flaky auth test.",
      });
      yield* test.decide({ action: "reply", speech: "The auth test is fixed and all 12 pass." });
      yield* pause(1500);
      const delegated = yield* until((output) => output.type === "delegated");
      assert.deepStrictEqual(spoken(delegated), ["On it."]);
      yield* until((output) => output.type === "speak" && output.text.startsWith("The auth"));
      const event = delegated.at(-1);
      assert.strictEqual(event?.type === "delegated" && event.text, test.prompts[0]);
      assert.deepStrictEqual(
        lastUser(test.asked[1]!),
        "[Agent finished]\nFixed the flaky test in auth.test.ts. All 12 pass.",
      );
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.scoped),
);

it.effect("ignores the mic while muted and ends an idle call by audio", () =>
  Effect.gen(function* () {
    const test = yield* harness("idle", []);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { voice, until, pause, fed } = yield* test.call({ idleTimeout: "min_5" });
        assert.deepStrictEqual(test.held, { stt: 1, tts: 1, front: 1 });
        yield* voice.mute;
        for (let chunk = 0; chunk < 4; chunk++) yield* voice.hear(new Uint8Array(CHUNK * 4));
        assert.strictEqual(fed(), 0);
        yield* voice.unmute;
        yield* pause(5 * 60 * 1000 - 2500);
        yield* pause(500);
        yield* until((output) => output.type === "idle");
        yield* voice.ended;
      }).pipe(Effect.provide(test.layer)),
    );
    assert.deepStrictEqual(test.held, { stt: 0, tts: 0, front: 0 });
  }).pipe(Effect.scoped),
);
