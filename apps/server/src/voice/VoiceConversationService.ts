import {
  CommandId,
  MessageId,
  type RunId,
  type ThreadId,
  type VoiceConversationOptions,
  type VoiceConversationState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SpeechService from "../speech/SpeechService.ts";
import * as TextToSpeech from "../speech/TextToSpeech.ts";
import { DEFAULT_TURN_SETTINGS, makeTurnDetector } from "../speech/turns.ts";
import * as FrontModel from "./FrontModel.ts";
import {
  delegationText,
  limitSpeech,
  makeFrontHistory,
  noteText,
  type FrontInput,
} from "./prompts.ts";
import { makeSpeaker, type Speaker, type VoiceCallOutput } from "./speaker.ts";
import { classifyInterruption, ECHO_WINDOW_SAMPLES, heardOnlyEcho } from "./turnTaking.ts";

export type { VoiceCallOutput } from "./speaker.ts";

const IDLE_MINUTES = { min_5: 5, min_10: 10, min_30: 30, never: Infinity } as const;
/** A delegated run is checked on this often, so a long one never holds a single wait forever. */
const RUN_WAIT_MS = 10 * 60 * 1000;

export class VoiceCallError extends Schema.TaggedError<VoiceCallError>()("VoiceCallError", {
  operation: Schema.Literals(["thread", "listen", "speak", "think"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    switch (this.operation) {
      case "thread":
        return "The voice call couldn't open this thread.";
      case "listen":
        return "Speech recognition failed during the voice call.";
      case "speak":
        return "The voice couldn't be loaded.";
      case "think":
        return "The conversation model couldn't be loaded.";
    }
  }
}

export type VoiceCall = {
  /** One frame of 16 kHz mic PCM. */
  readonly hear: (pcm: Uint8Array) => Effect.Effect<void, VoiceCallError>;
  readonly played: (seq: number, sample: number) => Effect.Effect<void>;
  readonly mute: Effect.Effect<void, VoiceCallError>;
  readonly unmute: Effect.Effect<void>;
  /** Completes when the call ends itself: `idle` after the idle timeout. */
  readonly ended: Effect.Effect<"idle">;
};

export class VoiceConversationService extends Context.Service<
  VoiceConversationService,
  {
    /**
     * Starts a call on a thread. It holds speech recognition, the voice and the front
     * model until the scope closes, which is how every way out of a call frees them.
     */
    readonly start: (input: {
      readonly threadId: ThreadId;
      readonly options: VoiceConversationOptions;
      readonly send: (output: VoiceCallOutput) => Effect.Effect<void>;
    }) => Effect.Effect<VoiceCall, VoiceCallError, Scope.Scope>;
  }
>()("t3/voice/VoiceConversationService") {}

const make = Effect.gen(function* () {
  const speech = yield* SpeechService.SpeechService;
  const tts = yield* TextToSpeech.TextToSpeech;
  const frontModel = yield* FrontModel.FrontModel;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;

  const start = Effect.fn("VoiceConversationService.start")(function* ({
    threadId,
    options,
    send,
  }: Parameters<VoiceConversationService["Service"]["start"]>[0]) {
    yield* Effect.annotateCurrentSpan({ threadId });
    const scope = yield* Effect.scope;
    const target = yield* threads.getThreadRecords(threadId, []).pipe(
      Effect.filterOrFail(
        (records) => records.thread.deletedAt === null && records.thread.archivedAt === null,
        (records) => new Error(`Thread ${records.thread.id} is closed.`),
      ),
      Effect.mapError((cause) => new VoiceCallError({ operation: "thread", cause })),
    );
    const thread = { projectId: target.thread.projectId, threadId };
    const [stt, , front] = yield* Effect.all(
      [
        speech
          .startStream(options.transcription, "conversation")
          .pipe(Effect.mapError((cause) => new VoiceCallError({ operation: "listen", cause }))),
        tts.hold.pipe(
          Effect.mapError((cause) => new VoiceCallError({ operation: "speak", cause })),
        ),
        frontModel.acquire.pipe(
          Effect.mapError((cause) => new VoiceCallError({ operation: "think", cause })),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const detector = makeTurnDetector({
      ...DEFAULT_TURN_SETTINGS,
      ...(options.endSilenceMs === undefined ? {} : { endSilenceMs: options.endSilenceMs }),
      ...(options.endSilenceLongMs === undefined
        ? {}
        : { endSilenceLongMs: options.endSilenceLongMs }),
    });
    const idleSamples = 16_000 * 60 * IDLE_MINUTES[options.idleTimeout ?? "min_10"];
    const ended = yield* Deferred.make<"idle">();
    const history = makeFrontHistory();
    let state: VoiceConversationState | undefined;
    let muted = false;
    /** Mic samples since the call began, muted or not: the call's clock. */
    let clock = 0;
    let silent = 0;
    let utterance = { text: "", heard: false };
    /** Speech that started while the voice was speaking, and what the voice had left to say. */
    let interruption: { start: number; rest: string | undefined } | undefined;
    let pending: FrontInput[] = [];
    let thinking: { fiber: Fiber.Fiber<void>; inputs: readonly FrontInput[] } | undefined;
    const notes: string[] = [];
    const runs = new Set<RunId>();
    let playedWords: { word: string; at: number }[] = [];

    const refresh: Effect.Effect<void> = Effect.suspend(() => {
      const next: VoiceConversationState = speaker.busy()
        ? "speaking"
        : thinking
          ? "thinking"
          : runs.size > 0
            ? "delegated"
            : "listening";
      if (next === state) return Effect.void;
      state = next;
      return send({ type: "state", state: next });
    });
    const speaker: Speaker = yield* makeSpeaker({
      send,
      tts,
      voice: options.voice,
      changed: refresh,
    });
    const echo = () => {
      playedWords = playedWords.filter(({ at }) => clock - at <= ECHO_WINDOW_SAMPLES);
      return new Set(playedWords.map(({ word }) => word));
    };
    const ids = Effect.fn("VoiceConversationService.ids")(function* () {
      const id = yield* random.uuidV4().pipe(Effect.orDie);
      return { commandId: CommandId.make(`voice:${id}`), messageId: MessageId.make(`voice:${id}`) };
    });
    const sendToThread = Effect.fn("VoiceConversationService.sendToThread")(function* (
      text: string,
      mode: "auto" | "steer",
    ) {
      return yield* threads.sendToThread({
        ...thread,
        ...(yield* ids()),
        text,
        attachments: [],
        mode,
        createdBy: "user",
        creationSource: options.source,
      });
    });

    // A note steers a run that is working; with none, it rides along with the next request.
    const deliverNote = Effect.fn("VoiceConversationService.deliverNote")(function* (note: string) {
      if (runs.size === 0) return void notes.push(note);
      yield* sendToThread(noteText(note), "steer").pipe(
        Effect.catch((cause) =>
          Effect.logWarning("voice call note held for the next request", { cause }).pipe(
            Effect.andThen(Effect.sync(() => notes.push(note))),
          ),
        ),
      );
    });

    const watch = Effect.fn("VoiceConversationService.watchRun")(function* (runId: RunId) {
      let waited = yield* threads.waitForThread({ ...thread, runId, timeoutMs: RUN_WAIT_MS });
      while (waited.timedOut) {
        waited = yield* threads.waitForThread({ ...thread, runId, timeoutMs: RUN_WAIT_MS });
      }
      const run = waited.run;
      if (!run) return;
      // A restart continues a cut run as a new one; its answer is the one to read.
      const records = yield* threads.getProjectThreadRecords(thread, ["turnItems"], {
        turnItemTypes: ["assistant_message"],
        turnItemRunIds: [run.id],
      });
      const answer = records.turnItems
        .filter((item) => item.type === "assistant_message" && !item.streaming)
        .at(-1);
      pending.push({
        type: "result",
        status: run.status,
        text: answer?.type === "assistant_message" ? answer.text : "",
      });
    });
    const follow = Effect.fn("VoiceConversationService.follow")(function* (runId: RunId) {
      if (runs.has(runId)) return;
      runs.add(runId);
      yield* watch(runId).pipe(
        Effect.catch((cause) => Effect.logError("voice call lost track of a run", { cause })),
        Effect.ensuring(
          Effect.suspend(() => {
            runs.delete(runId);
            // Thinking first, so the call never reports listening on its way to a readback.
            return think.pipe(Effect.andThen(refresh));
          }),
        ),
        Effect.forkIn(scope),
      );
    });

    const act = Effect.fn("VoiceConversationService.act")(function* (
      decision: FrontModel.FrontDecision,
      inputs: readonly FrontInput[],
    ) {
      const speech = limitSpeech(decision.speech);
      if (speech) yield* speaker.speak(speech);
      const said = inputs.flatMap((input) => (input.type === "user" ? [input.text] : [])).join(" ");
      // Only the user starts work: acting on a bare agent result would loop run after run.
      if (!said) return;
      if (decision.action === "note") yield* deliverNote(decision.task?.trim() || said);
      if (decision.action !== "delegate") return;
      const text = delegationText({ words: said, task: decision.task, notes: notes.splice(0) });
      const sent = yield* sendToThread(text, "auto");
      yield* send({ type: "delegated", runId: sent.run.id, text });
      yield* follow(sent.run.id);
    });

    // The front answers once the user has finished: what they say next joins this turn.
    const think: Effect.Effect<void> = Effect.suspend(() => {
      if (thinking || pending.length === 0 || utterance.heard || interruption) return Effect.void;
      const inputs = pending;
      pending = [];
      return Effect.gen(function* () {
        const decision = yield* front.decide(history.messages(inputs));
        // Committed before acting, so a barge-in from here on no longer takes the turn back.
        history.commit(inputs, decision);
        thinking = undefined;
        yield* act(decision, inputs);
      }).pipe(
        // The user hears that the turn failed rather than waiting on silence.
        Effect.catch((cause) =>
          Effect.logError("voice call turn failed", { cause }).pipe(
            Effect.andThen(speaker.speak("Sorry, that didn't work. Please try again.")),
            Effect.asVoid,
          ),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            if (thinking?.inputs === inputs) thinking = undefined;
            return think.pipe(Effect.andThen(refresh));
          }),
        ),
        Effect.forkIn(scope),
        Effect.flatMap((fiber) =>
          Effect.sync(() => {
            thinking = { fiber, inputs };
          }),
        ),
        Effect.andThen(refresh),
      );
    });
    const stopThinking = Effect.suspend(() => {
      const current = thinking;
      if (!current) return Effect.void;
      thinking = undefined;
      pending = [...current.inputs, ...pending];
      return Fiber.interrupt(current.fiber).pipe(Effect.andThen(refresh));
    });

    const nextUtterance = Effect.fn("VoiceConversationService.nextUtterance")(function* () {
      const text = yield* stt.next;
      utterance = { text: "", heard: false };
      detector.reset();
      return text;
    });
    const listen = Effect.fn("VoiceConversationService.listen")(function* (pcm: Uint8Array) {
      const update = yield* stt.feed(pcm);
      if (update.text) {
        utterance.text = `${update.text.committed}${update.text.tentative}`;
        yield* send({ type: "caption", who: "you", ...update.text });
      }
      const chunkStart = update.samples - pcm.byteLength / 4;
      const turn = detector.observe({
        samples: update.samples,
        voicedUntil: update.voicedUntil,
        text: utterance.text,
      });
      if (turn.heard) utterance.heard = true;
      if (turn.speechStarted) {
        yield* stopThinking;
        if (speaker.busy() && !interruption) interruption = { start: chunkStart, rest: undefined };
      }
      if (interruption) {
        // Speech over the voice pauses it, unless every word so far is the voice's own echo.
        if (interruption.rest === undefined && !heardOnlyEcho(utterance.text, echo()))
          interruption.rest = yield* speaker.cut;
        const verdict = classifyInterruption({
          text: utterance.text,
          start: interruption.start,
          voicedUntil: update.voicedUntil,
          samples: update.samples,
          echo: echo(),
        });
        if (verdict === "echo" || verdict === "backchannel") {
          const { rest } = interruption;
          interruption = undefined;
          const heard = yield* nextUtterance();
          yield* send({ type: "caption", who: "you", committed: "", tentative: "" });
          if (rest) yield* speaker.speak(rest);
          if (verdict === "backchannel") yield* deliverNote(`The user said "${heard.trim()}".`);
          return turn;
        }
        if (verdict === "turn") {
          if (interruption.rest === undefined) yield* speaker.cut;
          interruption = undefined;
        }
      }
      if (turn.ended) {
        const text = (yield* nextUtterance()).trim();
        if (text) {
          yield* send({ type: "caption", who: "you", committed: text, tentative: "" });
          pending.push({ type: "user", text });
        }
      }
      yield* think;
      return turn;
    });

    const call: VoiceCall = {
      hear: Effect.fn("VoiceConversationService.hear")(
        function* (pcm: Uint8Array) {
          const samples = pcm.byteLength / 4;
          clock += samples;
          const turn = muted ? undefined : yield* listen(pcm);
          silent = turn?.heard || state !== "listening" ? 0 : silent + samples;
          if (silent >= idleSamples) {
            yield* send({ type: "idle" });
            yield* Deferred.succeed(ended, "idle");
          }
        },
        Effect.mapError((cause) => new VoiceCallError({ operation: "listen", cause })),
      ),
      played: Effect.fn("VoiceConversationService.played")(function* (seq: number, sample: number) {
        const fresh = yield* speaker.played(seq, sample);
        echo();
        for (const word of fresh) playedWords.push({ word, at: clock });
      }),
      mute: Effect.gen(function* () {
        muted = true;
        interruption = undefined;
        if (utterance.text || utterance.heard) {
          yield* nextUtterance();
          yield* send({ type: "caption", who: "you", committed: "", tentative: "" });
          yield* think;
        }
      }).pipe(
        Effect.mapError((cause) => new VoiceCallError({ operation: "listen", cause })),
        Effect.withSpan("VoiceConversationService.mute"),
      ),
      unmute: Effect.sync(() => {
        muted = false;
      }),
      ended: Deferred.await(ended),
    };
    yield* send({ type: "ready" });
    yield* refresh;
    return call;
  });

  return VoiceConversationService.of({ start });
});

export const layer = Layer.effect(VoiceConversationService, make);
