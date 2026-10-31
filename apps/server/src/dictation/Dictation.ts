import * as Crypto from "effect/Crypto";
import {
  DICTATION_MAX_SECONDS,
  DICTATION_SAMPLE_RATE,
  DictationError,
  DictationSessionId,
  type DictationInstallState,
  type DictationModelId,
  type DictationAppendInput,
  type DictationCancelInput,
  type DictationFinishInput,
  type DictationFinishResult,
  type DictationInstallInput,
  type DictationRemoveInput,
  type DictationSettings,
  type DictationStartResult,
  type DictationState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ServerSettings from "../serverSettings.ts";
import * as DictationArtifacts from "./DictationArtifacts.ts";
import * as DictationRecognizer from "./DictationRecognizer.ts";
import { concatenate, decodePcm, findSplit, joinTexts, takeOrderedChunks } from "./audio.ts";
import { models, resolveLanguage } from "./models.ts";

interface Installation {
  readonly model: DictationModelId;
  fiber: Fiber.Fiber<void> | null;
}

interface LoadedModel {
  model: DictationSettings["localModel"];
  loading: Fiber.Fiber<void> | null;
  recognizer: DictationRecognizer.Recognizer | null;
  error: DictationError | null;
  retired: boolean;
}
interface Session {
  id: DictationSessionId;
  model: LoadedModel;
  language: string;
  chunks: Map<number, Float32Array>;
  next: number;
  samples: number;
  pending: Float32Array[];
  pendingSamples: number;
  attemptedSamples: number;
  texts: string[];
  locale: string;
  changed: Deferred.Deferred<void>;
  worker: Fiber.Fiber<void> | null;
  busy: boolean;
  closed: boolean;
  finishing: boolean;
  expectedChunks: number | null;
  lastUse: number;
  error: DictationError | null;
}

export class Dictation extends Context.Service<
  Dictation,
  {
    readonly state: Effect.Effect<DictationState>;
    readonly stateStream: Stream.Stream<DictationState>;
    readonly install: (input: DictationInstallInput) => Effect.Effect<void, DictationError>;
    readonly remove: (input: DictationRemoveInput) => Effect.Effect<void, DictationError>;
    readonly start: Effect.Effect<DictationStartResult, DictationError>;
    readonly warm: Effect.Effect<void>;
    readonly append: (input: DictationAppendInput) => Effect.Effect<void, DictationError>;
    readonly finish: (
      input: DictationFinishInput,
    ) => Effect.Effect<DictationFinishResult, DictationError>;
    readonly cancel: (input: DictationCancelInput) => Effect.Effect<void, DictationError>;
  }
>()("t3/dictation/Dictation") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const settings = yield* ServerSettings.ServerSettingsService;
  const artifacts = yield* DictationArtifacts.DictationArtifacts;
  const recognizers = yield* DictationRecognizer.DictationRecognizer;
  const settingsChanges = yield* settings.subscribeChanges;
  const readSettings = settings.getSettings.pipe(
    Effect.mapError(
      (cause) =>
        new DictationError({
          reason: "disabled",
          message: "Could not read dictation settings.",
          cause,
        }),
    ),
  );
  const initialSettings = yield* readSettings;
  // An unreadable state directory must not stop the server from starting; it reads as not installed.
  const installed = yield* artifacts.inspect.pipe(
    Effect.orElseSucceed(() => ({
      runtime: { _tag: "not-installed" } satisfies DictationInstallState,
      models: new Map<DictationModelId, DictationInstallState>(),
    })),
  );
  const state = yield* SubscriptionRef.make<DictationState>({
    supported: artifacts.supported,
    settings: initialSettings.dictation,
    runtime: installed.runtime,
    models: (Object.keys(models) as DictationSettings["localModel"][]).map((id) => ({
      id,
      label: models[id].label,
      languages: models[id].languages,
      languageOptions: models[id].languageOptions,
      note: models[id].note,
      downloadBytes: models[id].files.reduce((n, file) => n + file.bytes, 0),
      install: installed.models.get(id) ?? { _tag: "not-installed" },
    })),
    loadedModel: null,
    ready: false,
  });
  const update = (change: (current: DictationState) => DictationState) =>
    SubscriptionRef.update(state, (current) => {
      const next = change(current);
      return {
        ...next,
        ready:
          next.supported &&
          next.settings.engine === "local" &&
          next.runtime._tag === "installed" &&
          next.models.some(
            (model) => model.id === next.settings.localModel && model.install._tag === "installed",
          ),
      };
    });
  yield* update((current) => current);
  // Native work cannot be cancelled. Hold its permit until it really returns, including on cancellation.
  const native = yield* Semaphore.make(1);
  const lifecycle = yield* Semaphore.make(1);
  const sessions = new Map<DictationSessionId, Session>();
  let loaded: LoadedModel | null = null;
  let lastModelUse = yield* Clock.currentTimeMillis;
  let installing: Installation | null = null;

  const close = Effect.fnUntraced(function* (session: Session) {
    session.closed = true;
    sessions.delete(session.id);
    session.chunks.clear();
    session.pending = [];
    session.texts = [];
    session.pendingSamples = 0;
    yield* Deferred.succeed(session.changed, undefined);
    session.worker?.interruptUnsafe();
  });
  const unload = Effect.fnUntraced(function* () {
    const previous = loaded;
    loaded = null;
    if (previous) {
      previous.retired = true;

      for (const session of sessions.values())
        if (session.model === previous) yield* close(session);
      const release = native.withPermit(
        Effect.gen(function* () {
          if (previous.recognizer) yield* previous.recognizer.release;
          previous.recognizer = null;
        }),
      );
      yield* release.pipe(Effect.forkIn(scope, { startImmediately: true }));
    }
    yield* update((current) => ({ ...current, loadedModel: null }));
  });
  const progress: Parameters<DictationArtifacts.DictationArtifacts["Service"]["install"]>[1] = (
    artifact,
    install,
  ) =>
    update((current) =>
      artifact === "runtime"
        ? { ...current, runtime: install }
        : {
            ...current,
            models: current.models.map((model) =>
              model.id === artifact ? { ...model, install } : model,
            ),
          },
    );
  const stopInstallation = Effect.fnUntraced(function* () {
    const previous = installing;
    installing = null;
    if (!previous) return;
    if (previous.fiber) yield* Fiber.interrupt(previous.fiber);
    const snapshot = yield* artifacts.inspect.pipe(Effect.orElseSucceed(() => null));
    yield* update((current) => ({
      ...current,
      runtime: snapshot?.runtime ?? { _tag: "not-installed" },
      models: current.models.map((model) =>
        model.id === previous.model
          ? { ...model, install: snapshot?.models.get(model.id) ?? { _tag: "not-installed" } }
          : model,
      ),
    }));
  });
  // The lifecycle permit protects claiming the job; the download belongs to the service, not its RPC caller.
  const beginInstallation = Effect.fnUntraced(function* (model: DictationModelId, retry: boolean) {
    const current = yield* SubscriptionRef.get(state);
    if (
      !current.supported ||
      current.settings.engine !== "local" ||
      current.settings.localModel !== model ||
      installing
    )
      return;
    const modelState = current.models.find((candidate) => candidate.id === model)?.install;
    if (current.runtime._tag === "installed" && modelState?._tag === "installed") return;
    if (
      !retry &&
      (current.runtime._tag === "failed" ||
        modelState?._tag === "failed" ||
        modelState?._tag === "installing")
    )
      return;
    const job: Installation = { model, fiber: null };
    installing = job;
    yield* progress(model, {
      _tag: "installing",
      receivedBytes: 0,
      totalBytes: models[model].files.reduce((n, file) => n + file.bytes, 0),
    });
    const failInstallation = (message: string) =>
      update((current) => {
        if (installing !== job) return current;
        // Publish failure and release ownership together so an immediate retry can claim the job.
        installing = null;
        return {
          ...current,
          runtime:
            current.runtime._tag === "installing" ? { _tag: "failed", message } : current.runtime,
          models: current.models.map((candidate) =>
            candidate.id === model
              ? { ...candidate, install: { _tag: "failed", message } }
              : candidate,
          ),
        };
      });
    job.fiber = yield* artifacts
      .install(model, (artifact, value) =>
        Effect.suspend(() => (installing === job ? progress(artifact, value) : Effect.void)),
      )
      .pipe(
        Effect.catchTags({
          DictationError: (error) => failInstallation(error.message),
        }),
        Effect.catchCause(() => failInstallation("Dictation installation failed.")),
        Effect.ensuring(
          Effect.sync(() => {
            if (installing === job) installing = null;
          }),
        ),
        Effect.forkIn(scope),
      );
  }, Effect.uninterruptible);
  const reconcileSettings = Effect.fnUntraced(function* () {
    let next = (yield* readSettings).dictation;
    const before = yield* SubscriptionRef.get(state);
    if (before.settings.engine !== next.engine || before.settings.localModel !== next.localModel) {
      yield* stopInstallation();
      yield* unload();
      // Cancellation can wait for cleanup while settings change again. Claim from the latest selection.
      next = (yield* readSettings).dictation;
    }
    const current = yield* SubscriptionRef.get(state);
    const activationChanged =
      current.settings.engine !== next.engine || current.settings.localModel !== next.localModel;
    if (activationChanged || current.settings.language !== next.language) {
      yield* update((current) => ({
        ...current,
        settings: next,
        runtime:
          activationChanged && next.engine === "local" && current.runtime._tag === "failed"
            ? { _tag: "not-installed" }
            : current.runtime,
        models: current.models.map((model) =>
          activationChanged &&
          next.engine === "local" &&
          model.id === next.localModel &&
          model.install._tag === "failed"
            ? { ...model, install: { _tag: "not-installed" } }
            : model,
        ),
      }));
    }
    yield* beginInstallation(next.localModel, false);
  }, Effect.uninterruptible);
  yield* settingsChanges.pipe(
    Stream.runForEach(() =>
      reconcileSettings().pipe(
        lifecycle.withPermit,
        Effect.catchTags({
          DictationError: (error) =>
            Effect.logWarning("Could not reconcile dictation settings.").pipe(
              Effect.annotateLogs({ reason: error.reason }),
            ),
        }),
      ),
    ),
    Effect.forkIn(scope),
  );
  const install = Effect.fnUntraced(function* (input: DictationInstallInput) {
    yield* lifecycle.withPermit(
      Effect.gen(function* () {
        yield* reconcileSettings();
        const current = yield* SubscriptionRef.get(state);
        if (!current.supported)
          return yield* new DictationError({
            reason: "unsupported-platform",
            message: "Local dictation is unavailable on this platform.",
          });
        if (current.settings.engine !== "local" || current.settings.localModel !== input.model)
          return yield* new DictationError({
            reason: "disabled",
            message: "Activate this model before installing it.",
          });
        yield* beginInstallation(input.model, true);
      }),
    );
  });
  // Removing the active model is a no-op. Deactivate it or choose another model before reclaiming its files.
  const remove = Effect.fnUntraced(function* (input: DictationRemoveInput) {
    yield* lifecycle.withPermit(
      Effect.gen(function* () {
        yield* reconcileSettings();
        const current = yield* SubscriptionRef.get(state);
        if (current.settings.engine === "local" && current.settings.localModel === input.model)
          return;
        yield* progress(input.model, { _tag: "not-installed" });
        // Retired recognizers must release their handle before their files are deleted.
        yield* native.withPermit(artifacts.remove(input.model)).pipe(
          Effect.catchTags({
            DictationError: Effect.fn("Dictation.removeFailure")(function* (error) {
              const snapshot = yield* artifacts.inspect.pipe(Effect.orElseSucceed(() => null));
              yield* progress(
                input.model,
                snapshot?.models.get(input.model) ?? {
                  _tag: "failed",
                  message: "Could not remove dictation files.",
                },
              );
              return yield* error;
            }),
          }),
        );
      }).pipe(Effect.uninterruptible),
    );
  });

  /**
   * Starts loading the selected model in the background unless it is already
   * loaded or loading, and counts as use for the 30 minute idle unload.
   */
  const ensureLoaded = Effect.fn("Dictation.ensureLoaded")(function* (
    current: DictationState,
  ): Effect.fn.Return<LoadedModel, DictationError> {
    lastModelUse = yield* Clock.currentTimeMillis;
    if (loaded?.error) yield* unload();
    if (!loaded) {
      const slot: LoadedModel = {
        model: current.settings.localModel,
        loading: null,
        recognizer: null,
        error: null,
        retired: false,
      };
      loaded = slot;
      slot.loading = yield* native
        .withPermit(
          Effect.gen(function* () {
            if (slot.retired) return;
            const recognizer = yield* recognizers
              .load(slot.model, current.settings.language)
              .pipe(Effect.uninterruptible);
            if (slot.retired) {
              yield* recognizer.release;
              return;
            }
            slot.recognizer = recognizer;
            yield* update((current) => ({ ...current, loadedModel: slot.model }));
          }),
        )
        .pipe(
          Effect.catchTags({
            DictationError: (error) =>
              Effect.sync(() => {
                slot.error = error;
              }),
          }),
          Effect.forkIn(scope),
        );
    }
    return loaded;
  });

  /**
   * Best-effort warm-up for a client that is about to dictate, e.g. when its
   * composer gains focus. Does nothing unless dictation is on and installed.
   */
  const warm = Effect.gen(function* () {
    yield* reconcileSettings();
    const current = yield* SubscriptionRef.get(state);
    // A failed load is retried by the next recording, not by every warm-up.
    if (loaded) return;
    if (current.supported && current.settings.engine === "local" && current.ready) {
      yield* ensureLoaded(current);
    }
  }).pipe(
    // Same permit as start, install, and remove, so a warm-up never races a removal.
    lifecycle.withPermit,
    Effect.catchTags({ DictationError: () => Effect.void }),
  );

  const start = Effect.gen(function* () {
    yield* reconcileSettings();
    const current = yield* SubscriptionRef.get(state);
    if (!current.supported)
      return yield* new DictationError({
        reason: "unsupported-platform",
        message: "Local dictation is unavailable on this platform.",
      });
    if (current.settings.engine !== "local")
      return yield* new DictationError({
        reason: "disabled",
        message: "Enable local dictation in environment settings.",
      });
    if (!current.ready)
      return yield* new DictationError({
        reason: "not-installed",
        message: "Install the dictation model first.",
      });
    if (sessions.size >= 4)
      return yield* new DictationError({
        reason: "transcription-failed",
        message: "Too many dictation sessions are active.",
      });
    const model = yield* ensureLoaded(current);
    const id = DictationSessionId.make(
      yield* crypto.randomUUIDv4().pipe(
        Effect.mapError(
          (cause) =>
            new DictationError({
              reason: "transcription-failed",
              message: "Could not create a dictation session.",
              cause,
            }),
        ),
      ),
    );
    const session: Session = {
      id,
      model,
      language: resolveLanguage(current.settings.localModel, current.settings.language),
      chunks: new Map(),
      next: 0,
      samples: 0,
      pending: [],
      pendingSamples: 0,
      attemptedSamples: 0,
      texts: [],
      locale: resolveLanguage(current.settings.localModel, current.settings.language) || "en",
      changed: yield* Deferred.make<void>(),
      worker: null,
      busy: false,
      closed: false,
      finishing: false,
      expectedChunks: null,
      lastUse: lastModelUse,
      error: null,
    };
    sessions.set(id, session);
    return { sessionId: id };
  }).pipe(lifecycle.withPermit);

  const getSession = (id: DictationSessionId) =>
    Effect.suspend(() => {
      const session = sessions.get(id);
      return session
        ? Effect.succeed(session)
        : Effect.fail(
            new DictationError({
              reason: "unknown-session",
              message: "This dictation session has ended.",
            }),
          );
    });
  const decode = Effect.fnUntraced(function* (session: Session, samples: Float32Array) {
    if (session.model.loading) yield* Fiber.join(session.model.loading);
    if (session.model.error) return yield* session.model.error;
    yield* native.withPermit(
      Effect.gen(function* () {
        if (session.closed || !session.model.recognizer) return;
        const result = yield* session.model.recognizer
          .decode(samples, session.language)
          .pipe(Effect.uninterruptible);
        if (!session.closed && result.text.trim()) {
          session.texts.push(result.text);
          session.locale = result.locale;
        }
      }),
    );
    lastModelUse = yield* Clock.currentTimeMillis;
  });
  const pump = Effect.fnUntraced(function* (session: Session) {
    if (
      session.busy ||
      session.closed ||
      session.error ||
      session.pendingSamples < 4 * DICTATION_SAMPLE_RATE ||
      session.pendingSamples - session.attemptedSamples < DICTATION_SAMPLE_RATE / 4
    )
      return;
    session.busy = true;
    session.worker = yield* Effect.gen(function* () {
      if (session.model.loading) yield* Fiber.join(session.model.loading);
      while (!session.closed) {
        const samples = concatenate(session.pending);
        session.attemptedSamples = samples.length;
        const split = findSplit(samples);
        if (split === null) break;
        session.pending = [samples.slice(split)];
        session.pendingSamples = samples.length - split;
        session.attemptedSamples = 0;
        yield* decode(session, samples.subarray(0, split));
      }
    }).pipe(
      Effect.catchTags({
        DictationError: (error) =>
          Effect.sync(() => {
            session.error = error;
          }),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          session.busy = false;
        }),
      ),
      Effect.forkIn(scope),
    );
  });
  const append = Effect.fnUntraced(function* (input: DictationAppendInput) {
    const session = yield* getSession(input.sessionId);
    if (input.seq < session.next || session.chunks.has(input.seq)) return;
    if (session.expectedChunks !== null && input.seq >= session.expectedChunks)
      return yield* new DictationError({
        reason: "transcription-failed",
        message: "The recording chunk count is invalid.",
      });
    if (
      input.seq >= 60_000 ||
      input.pcm.length > (DICTATION_MAX_SECONDS * DICTATION_SAMPLE_RATE * 2 * 4) / 3 + 4
    ) {
      yield* close(session);
      return yield* new DictationError({
        reason: "too-long",
        message: "The dictation recording is too long.",
      });
    }
    const samples = yield* Effect.try({
      try: () => decodePcm(input.pcm),
      catch: (cause) =>
        new DictationError({
          reason: "transcription-failed",
          message: "The recording contains invalid PCM.",
          cause,
        }),
    });
    if (samples.length === 0)
      return yield* new DictationError({
        reason: "transcription-failed",
        message: "The recording chunk is empty.",
      });
    if (session.samples + samples.length > DICTATION_MAX_SECONDS * DICTATION_SAMPLE_RATE) {
      yield* close(session);
      return yield* new DictationError({
        reason: "too-long",
        message: "The dictation recording is too long.",
      });
    }
    session.lastUse = lastModelUse = yield* Clock.currentTimeMillis;
    session.samples += samples.length;
    session.chunks.set(input.seq, samples);
    const ordered = takeOrderedChunks(session.chunks, session.next);
    session.next = ordered.next;
    session.pending.push(...ordered.ordered);
    session.pendingSamples += ordered.ordered.reduce((n, chunk) => n + chunk.length, 0);
    const changed = session.changed;
    session.changed = yield* Deferred.make<void>();
    yield* Deferred.succeed(changed, undefined);
    yield* pump(session);
  });
  const finish = Effect.fnUntraced(function* (input: DictationFinishInput) {
    const session = yield* getSession(input.sessionId);
    if (session.finishing)
      return yield* new DictationError({
        reason: "transcription-failed",
        message: "This dictation session is already finishing.",
      });
    session.finishing = true;
    session.expectedChunks = input.chunkCount;
    const result = Effect.gen(function* () {
      if (
        input.chunkCount > 60_000 ||
        input.chunkCount < session.next ||
        [...session.chunks.keys()].some((seq) => seq >= input.chunkCount)
      )
        return yield* new DictationError({
          reason: "transcription-failed",
          message: "The recording chunk count is invalid.",
        });
      session.lastUse = lastModelUse = yield* Clock.currentTimeMillis;
      yield* Effect.gen(function* () {
        while (!session.closed && session.next < input.chunkCount)
          yield* Deferred.await(session.changed);
      }).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () =>
            Effect.fail(
              new DictationError({
                reason: "transcription-failed",
                message: "Some recording chunks did not arrive.",
              }),
            ),
        }),
      );
      if (session.worker) yield* Fiber.await(session.worker);
      if (session.closed)
        return yield* new DictationError({
          reason: "unknown-session",
          message: "This dictation session has ended.",
        });
      if (session.error) return yield* session.error;
      // Pump large backlogs before decoding the tail, even if the last append raced a worker's exit.
      const pending = concatenate(session.pending);
      session.pending = [];
      session.pendingSamples = 0;
      let offset = 0;
      while (offset < pending.length && !session.closed) {
        const split = findSplit(pending.subarray(offset));
        const end = split === null ? pending.length : offset + split;
        yield* decode(session, pending.subarray(offset, end));
        offset = end;
      }
      if (session.closed)
        return yield* new DictationError({
          reason: "unknown-session",
          message: "This dictation session has ended.",
        });
      return { text: joinTexts(session.texts), locale: session.locale };
    });
    return yield* result.pipe(Effect.ensuring(close(session)));
  });
  const cancel = Effect.fnUntraced(function* (input: DictationCancelInput) {
    yield* close(yield* getSession(input.sessionId));
  });

  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const session of sessions.values())
      if (!session.finishing && now - session.lastUse >= 60_000) yield* close(session);
    yield* lifecycle.withPermit(
      Effect.gen(function* () {
        if (loaded && sessions.size === 0 && now - lastModelUse >= 30 * 60_000) yield* unload();
      }),
    );
  }).pipe(Effect.repeat(Schedule.spaced("10 seconds")), Effect.forkIn(scope));
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const session of sessions.values()) yield* close(session);
      const previous = loaded;
      loaded = null;
      if (previous) previous.retired = true;
      yield* native.withPermit(
        Effect.gen(function* () {
          if (previous?.recognizer) yield* previous.recognizer.release;
          if (previous) previous.recognizer = null;
        }),
      );
    }),
  );
  yield* reconcileSettings().pipe(lifecycle.withPermit);
  return Dictation.of({
    state: SubscriptionRef.get(state),
    stateStream: SubscriptionRef.changes(state),
    install,
    remove,
    start,
    warm,
    append,
    finish,
    cancel,
  });
});

export const layer = Layer.effect(Dictation, make);
