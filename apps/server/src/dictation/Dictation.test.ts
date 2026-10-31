import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  DICTATION_MAX_SECONDS,
  DictationError,
  type DictationState,
  type DictationInstallState,
  type DictationModelId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSettings from "../serverSettings.ts";
import * as Dictation from "./Dictation.ts";
import * as DictationArtifacts from "./DictationArtifacts.ts";
import * as DictationRecognizer from "./DictationRecognizer.ts";

const testLayer = (
  options: {
    supported?: boolean;
    installed?: boolean;
    engine?: "off" | "local";
    localModel?: DictationModelId;
    language?: string;
    install?: DictationArtifacts.DictationArtifacts["Service"]["install"];
    remove?: DictationArtifacts.DictationArtifacts["Service"]["remove"];
    inspectFails?: boolean;
    load?: DictationRecognizer.DictationRecognizer["Service"]["load"];
  } = {},
) =>
  Dictation.layer.pipe(
    Layer.provide(
      Layer.sync(DictationArtifacts.DictationArtifacts, () => {
        let runtime: DictationInstallState =
          options.installed === false
            ? { _tag: "not-installed" }
            : { _tag: "installed", sizeBytes: 1 };
        const disk = new Map<DictationModelId, DictationInstallState>(
          ["parakeet-v3", "whisper-turbo", "moonshine-base"].map((model) => [
            model as DictationModelId,
            runtime,
          ]),
        );
        const complete: DictationArtifacts.DictationArtifacts["Service"]["install"] = (
          model,
          progress,
        ) =>
          Effect.gen(function* () {
            yield* progress("runtime", { _tag: "installed", sizeBytes: 1 });
            yield* progress(model, { _tag: "installed", sizeBytes: 1 });
          });
        return {
          supported: options.supported ?? true,
          paths: () => ({ runtime: "/unused", model: "/unused" }),
          inspect: options.inspectFails
            ? Effect.fail(
                new DictationError({ reason: "install-failed", message: "Unreadable state." }),
              )
            : Effect.sync(() => ({ runtime, models: new Map(disk) })),
          install: (model, progress) =>
            (options.install ?? complete)(model, (artifact, value) =>
              Effect.gen(function* () {
                if (value._tag === "installed") {
                  if (artifact === "runtime") runtime = value;
                  else disk.set(artifact, value);
                }
                yield* progress(artifact, value);
              }),
            ),
          remove: (model) =>
            (options.remove ?? (() => Effect.void))(model).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  disk.set(model, { _tag: "not-installed" });
                }),
              ),
            ),
        } satisfies DictationArtifacts.DictationArtifacts["Service"];
      }),
    ),
    Layer.provide(
      Layer.succeed(DictationRecognizer.DictationRecognizer, {
        load:
          options.load ??
          (() =>
            Effect.succeed({
              decode: (samples) =>
                Effect.succeed({
                  text: samples.find((sample) => sample !== 0)! < 0.15 ? "one" : "two",
                  locale: "en",
                }),
              release: Effect.void,
            })),
      }),
    ),
    Layer.provideMerge(
      Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const original = yield* ServerSettings.ServerSettingsService;
          const changes = yield* PubSub.unbounded<import("@t3tools/contracts").ServerSettings>();
          return {
            ...original,
            updateSettings: (patch) =>
              original
                .updateSettings(patch)
                .pipe(Effect.tap((next) => PubSub.publish(changes, next))),
            streamChanges: Stream.fromPubSub(changes),
            subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
          } satisfies ServerSettings.ServerSettingsService["Service"];
        }),
      ).pipe(
        Layer.provide(
          ServerSettings.layerTest({
            dictation: {
              engine: options.engine ?? "local",
              localModel: options.localModel ?? "parakeet-v3",
              language: options.language ?? "auto",
            },
          }),
        ),
      ),
    ),
    Layer.provide(NodeCrypto.layer),
  );

function pcm(seconds: number, value = 0.1) {
  const bytes = Buffer.alloc(seconds * 16000 * 2);
  for (let offset = 0; offset < bytes.length; offset += 2)
    bytes.writeInt16LE(Math.round(value * 32767), offset);
  return bytes.toString("base64");
}

it.effect("gates start on platform, settings and installed artifacts", () =>
  Effect.gen(function* () {
    for (const [options, reason] of [
      [{ supported: false }, "unsupported-platform"],
      [{ engine: "off" as const }, "disabled"],
      [{ installed: false, install: () => Effect.never }, "not-installed"],
    ] as const) {
      const result = yield* Effect.gen(function* () {
        return yield* (yield* Dictation.Dictation).start.pipe(Effect.flip);
      }).pipe(Effect.provide(testLayer(options)), Effect.scoped);
      assert.strictEqual(result.reason, reason);
    }
  }),
);

it.effect(
  "starts without awaiting cold load, decodes while recording and preserves final segment order",
  () =>
    Effect.gen(function* () {
      const loading = yield* Deferred.make<void>();
      const firstDecode = yield* Deferred.make<void>();
      const allowDecode = yield* Deferred.make<void>();
      let decoded = 0;
      const program = Effect.gen(function* () {
        const service = yield* Dictation.Dictation;
        const { sessionId } = yield* service.start;
        yield* service.append({ sessionId, seq: 1, pcm: pcm(0.5, 0) });
        yield* service.append({ sessionId, seq: 0, pcm: pcm(4) });
        yield* Deferred.succeed(loading, undefined);
        yield* Deferred.await(firstDecode);
        yield* service.append({ sessionId, seq: 2, pcm: pcm(2, 0.2) });
        yield* Deferred.succeed(allowDecode, undefined);
        const result = yield* service.finish({ sessionId, chunkCount: 3 });
        assert.deepStrictEqual(result, { text: "one two", locale: "fr" });
        assert.strictEqual(decoded, 2);
      });
      yield* program.pipe(
        Effect.provide(
          testLayer({
            load: () =>
              Deferred.await(loading).pipe(
                Effect.as({
                  decode: () =>
                    Effect.gen(function* () {
                      decoded++;
                      if (decoded === 1) {
                        yield* Deferred.succeed(firstDecode, undefined);
                        yield* Deferred.await(allowDecode);
                      }
                      return { text: decoded === 1 ? " one " : " two ", locale: "fr" };
                    }),
                  release: Effect.void,
                }),
              ),
          }),
        ),
        Effect.scoped,
      );
    }),
);

it.effect("finish accepts ordered stragglers and deduplicates retries", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const { sessionId } = yield* service.start;
    yield* service.append({ sessionId, seq: 1, pcm: pcm(0.1) });
    const finishing = yield* service.finish({ sessionId, chunkCount: 2 }).pipe(Effect.forkChild);
    yield* service.append({ sessionId, seq: 0, pcm: pcm(0.1) });
    yield* service.append({ sessionId, seq: 1, pcm: pcm(0.1) });
    assert.strictEqual((yield* Fiber.join(finishing)).text, "one");
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("cancel discards a recording and rejects later operations", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const { sessionId } = yield* service.start;
    yield* service.append({ sessionId, seq: 0, pcm: pcm(0.1) });
    yield* service.cancel({ sessionId });
    assert.strictEqual(
      (yield* service.finish({ sessionId, chunkCount: 1 }).pipe(Effect.flip)).reason,
      "unknown-session",
    );
    assert.strictEqual(
      (yield* service.cancel({ sessionId }).pipe(Effect.flip)).reason,
      "unknown-session",
    );
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("rejects recordings over the duration cap and frees the session", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const { sessionId } = yield* service.start;
    yield* service.append({ sessionId, seq: 0, pcm: pcm(DICTATION_MAX_SECONDS) });
    assert.strictEqual(
      (yield* service.append({ sessionId, seq: 1, pcm: pcm(0.1) }).pipe(Effect.flip)).reason,
      "too-long",
    );
    assert.strictEqual(
      (yield* service.finish({ sessionId, chunkCount: 2 }).pipe(Effect.flip)).reason,
      "unknown-session",
    );
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("expires abandoned sessions and observes engine-off settings", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const settings = yield* ServerSettings.ServerSettingsService;
    const { sessionId } = yield* service.start;
    yield* TestClock.adjust("70 seconds");
    assert.strictEqual(
      (yield* service.finish({ sessionId, chunkCount: 0 }).pipe(Effect.flip)).reason,
      "unknown-session",
    );
    const changed = yield* service.stateStream.pipe(
      Stream.filter((state: DictationState) => state.settings.engine === "off"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* settings.updateSettings({ dictation: { engine: "off" } });
    yield* Fiber.join(changed);
    assert.strictEqual((yield* service.start.pipe(Effect.flip)).reason, "disabled");
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("returns typed cold-load failures", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const { sessionId } = yield* service.start;
    yield* service.append({ sessionId, seq: 0, pcm: pcm(0.1) });
    assert.strictEqual(
      (yield* service.finish({ sessionId, chunkCount: 1 }).pipe(Effect.flip)).reason,
      "load-failed",
    );
  }).pipe(
    Effect.provide(
      testLayer({
        load: () =>
          Effect.fail(
            new DictationError({
              reason: "load-failed",
              message: "Could not load the dictation model.",
            }),
          ),
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("cancel suppresses a decode that is already running", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const complete = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const { sessionId } = yield* service.start;
      yield* service.append({ sessionId, seq: 0, pcm: pcm(4) });
      yield* service.append({ sessionId, seq: 1, pcm: pcm(0.5, 0) });
      yield* Deferred.await(started);
      yield* service.cancel({ sessionId });
      yield* Deferred.succeed(complete, undefined);
      assert.strictEqual(
        (yield* service.finish({ sessionId, chunkCount: 2 }).pipe(Effect.flip)).reason,
        "unknown-session",
      );
    }).pipe(
      Effect.provide(
        testLayer({
          load: () =>
            Effect.succeed({
              decode: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(complete)),
                  Effect.as({ text: "discarded", locale: "en" }),
                ),
              release: Effect.void,
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("unloads an idle recognizer and loads it again for a later recording", () =>
  Effect.gen(function* () {
    const released = yield* Deferred.make<void>();
    let loads = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const { sessionId } = yield* service.start;
      yield* service.append({ sessionId, seq: 0, pcm: pcm(0.1) });
      yield* service.finish({ sessionId, chunkCount: 1 });
      assert.strictEqual((yield* service.state).loadedModel, "parakeet-v3");
      yield* TestClock.adjust("31 minutes");
      yield* Deferred.await(released);
      assert.strictEqual((yield* service.state).loadedModel, null);
      const second = yield* service.start;
      yield* service.append({ sessionId: second.sessionId, seq: 0, pcm: pcm(0.1) });
      yield* service.finish({ sessionId: second.sessionId, chunkCount: 1 });
      assert.strictEqual(loads, 2);
    }).pipe(
      Effect.provide(
        testLayer({
          load: () =>
            Effect.sync(() => {
              loads++;
              return {
                decode: () => Effect.succeed({ text: "one", locale: "en" }),
                release: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
              };
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("keeps installed state honest when model removal fails", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const error = yield* service.remove({ model: "parakeet-v3" }).pipe(Effect.flip);
    assert.strictEqual(error.reason, "install-failed");
    const state = yield* service.state;
    assert.strictEqual(state.models[0]?.install._tag, "installed");
    assert.strictEqual(state.ready, false);
  }).pipe(
    Effect.provide(
      testLayer({
        engine: "off",
        remove: () =>
          Effect.fail(
            new DictationError({
              reason: "install-failed",
              message: "Could not access dictation files.",
            }),
          ),
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("completes removal coherently when its caller disconnects during a decode", () =>
  Effect.gen(function* () {
    const decoding = yield* Deferred.make<void>();
    const completeDecode = yield* Deferred.make<void>();
    const removed = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const { sessionId } = yield* service.start;
      yield* service.append({ sessionId, seq: 0, pcm: pcm(4) });
      yield* service.append({ sessionId, seq: 1, pcm: pcm(0.5, 0) });
      yield* Deferred.await(decoding);
      const removal = yield* service.remove({ model: "moonshine-base" }).pipe(Effect.forkChild);
      yield* service.stateStream.pipe(
        Stream.filter(
          (state) =>
            state.models.find((model) => model.id === "moonshine-base")?.install._tag ===
            "not-installed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      removal.interruptUnsafe();
      yield* Deferred.succeed(completeDecode, undefined);
      yield* Deferred.await(removed);
      yield* Fiber.await(removal);
      const state = yield* service.state;
      assert.strictEqual(state.ready, true);
      assert.strictEqual(state.loadedModel, "parakeet-v3");
      assert.strictEqual(
        (yield* service.finish({ sessionId, chunkCount: 2 })).text,
        "discarded discarded",
      );
    }).pipe(
      Effect.provide(
        testLayer({
          load: () =>
            Effect.succeed({
              decode: () =>
                Deferred.succeed(decoding, undefined).pipe(
                  Effect.andThen(Deferred.await(completeDecode)),
                  Effect.as({ text: "discarded", locale: "en" }),
                ),
              release: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
            }),
          remove: () => Deferred.succeed(removed, undefined).pipe(Effect.asVoid),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("engine off prevents automatic and explicit downloads", () =>
  Effect.gen(function* () {
    let installs = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      assert.strictEqual(
        (yield* service.install({ model: "parakeet-v3" }).pipe(Effect.flip)).reason,
        "disabled",
      );
      assert.strictEqual((yield* service.state).models[0]?.install._tag, "not-installed");
      assert.strictEqual(installs, 0);
    }).pipe(
      Effect.provide(
        testLayer({
          engine: "off",
          installed: false,
          install: () =>
            Effect.sync(() => {
              installs++;
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("activation starts one scoped install and retry RPC returns before it completes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const complete = yield* Deferred.make<void>();
    let installs = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ dictation: { engine: "local" } });
      yield* Deferred.await(started);
      yield* service.install({ model: "parakeet-v3" });
      yield* service.install({ model: "parakeet-v3" });
      yield* settings.updateSettings({ dictation: { language: "en" } });
      assert.strictEqual((yield* service.state).models[0]?.install._tag, "installing");
      assert.strictEqual(installs, 1);
      yield* Deferred.succeed(complete, undefined);
      yield* service.stateStream.pipe(
        Stream.filter((state) => state.ready),
        Stream.take(1),
        Stream.runDrain,
      );
    }).pipe(
      Effect.provide(
        testLayer({
          engine: "off",
          installed: false,
          install: (model, progress) =>
            Effect.gen(function* () {
              installs++;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(complete);
              yield* progress("runtime", { _tag: "installed", sizeBytes: 1 });
              yield* progress(model, { _tag: "installed", sizeBytes: 1 });
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("a failed activation waits for explicit retry or re-selection", () =>
  Effect.gen(function* () {
    let installs = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const settings = yield* ServerSettings.ServerSettingsService;
      const failed = () =>
        service.stateStream.pipe(
          Stream.filter(
            (state) =>
              state.models.find((model) => model.id === state.settings.localModel)?.install._tag ===
              "failed",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
      yield* failed();
      yield* settings.updateSettings({ dictation: { language: "en" } });
      assert.strictEqual((yield* service.start.pipe(Effect.flip)).reason, "not-installed");
      assert.strictEqual(installs, 1);
      yield* service.install({ model: "parakeet-v3" });
      yield* failed();
      assert.strictEqual(installs, 2);
      yield* settings.updateSettings({ dictation: { localModel: "moonshine-base" } });
      yield* service.stateStream.pipe(
        Stream.filter(
          (state) =>
            state.settings.localModel === "moonshine-base" &&
            state.models.find((model) => model.id === "moonshine-base")?.install._tag === "failed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      assert.strictEqual(installs, 3);
      yield* settings.updateSettings({ dictation: { localModel: "parakeet-v3" } });
      yield* service.stateStream.pipe(
        Stream.filter(
          (state) =>
            state.settings.localModel === "parakeet-v3" &&
            state.models[0]?.install._tag === "failed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      assert.strictEqual(installs, 4);
    }).pipe(
      Effect.provide(
        testLayer({
          installed: false,
          install: () =>
            Effect.gen(function* () {
              installs++;
              return yield* new DictationError({
                reason: "install-failed",
                message: "Dictation installation failed.",
              });
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("turning off cancels a download, and removing the active model is a no-op", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    let removals = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* Deferred.await(started);
      yield* service.remove({ model: "parakeet-v3" });
      assert.strictEqual(removals, 0);
      yield* settings.updateSettings({ dictation: { engine: "off" } });
      yield* Deferred.await(cancelled);
      yield* service.stateStream.pipe(
        Stream.filter((state) => state.settings.engine === "off"),
        Stream.take(1),
        Stream.runDrain,
      );
      assert.strictEqual((yield* service.state).models[0]?.install._tag, "not-installed");
    }).pipe(
      Effect.provide(
        testLayer({
          installed: false,
          install: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(cancelled, undefined)),
            ),
          remove: () =>
            Effect.sync(() => {
              removals++;
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect(
  "language changes apply to the next session while existing sessions retain their language",
  () =>
    Effect.gen(function* () {
      const languages: string[] = [];
      yield* Effect.gen(function* () {
        const service = yield* Dictation.Dictation;
        const settings = yield* ServerSettings.ServerSettingsService;
        const first = yield* service.start;
        yield* settings.updateSettings({ dictation: { language: "nl" } });
        const second = yield* service.start;
        yield* service.append({ sessionId: first.sessionId, seq: 0, pcm: pcm(0.1) });
        yield* service.finish({ sessionId: first.sessionId, chunkCount: 1 });
        yield* service.append({ sessionId: second.sessionId, seq: 0, pcm: pcm(0.1) });
        assert.strictEqual(
          (yield* service.finish({ sessionId: second.sessionId, chunkCount: 1 })).locale,
          "nl",
        );
        yield* settings.updateSettings({ dictation: { language: "invalid" } });
        const third = yield* service.start;
        yield* service.append({ sessionId: third.sessionId, seq: 0, pcm: pcm(0.1) });
        yield* service.finish({ sessionId: third.sessionId, chunkCount: 1 });
        assert.deepStrictEqual(languages, ["en", "nl", ""]);
      }).pipe(
        Effect.provide(
          testLayer({
            localModel: "whisper-turbo",
            language: "en",
            load: () =>
              Effect.succeed({
                decode: (_samples, language) =>
                  Effect.sync(() => {
                    languages.push(language);
                    return { text: "one", locale: language || "en" };
                  }),
                release: Effect.void,
              }),
          }),
        ),
        Effect.scoped,
      );
    }),
);

it.effect("switching models retires the previous recognizer", () =>
  Effect.gen(function* () {
    const released = yield* Deferred.make<void>();
    const loaded: DictationModelId[] = [];
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const settings = yield* ServerSettings.ServerSettingsService;
      const first = yield* service.start;
      yield* service.append({ sessionId: first.sessionId, seq: 0, pcm: pcm(0.1) });
      yield* service.finish({ sessionId: first.sessionId, chunkCount: 1 });
      yield* settings.updateSettings({ dictation: { localModel: "moonshine-base" } });
      const second = yield* service.start;
      yield* Deferred.await(released);
      yield* service.append({ sessionId: second.sessionId, seq: 0, pcm: pcm(0.1) });
      yield* service.finish({ sessionId: second.sessionId, chunkCount: 1 });
      assert.deepStrictEqual(loaded, ["parakeet-v3", "moonshine-base"]);
    }).pipe(
      Effect.provide(
        testLayer({
          load: (model) =>
            Effect.sync(() => {
              loaded.push(model);
              return {
                decode: () => Effect.succeed({ text: "one", locale: "en" }),
                release: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
              };
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("explicit retry outlives its RPC scope and returns before downloading completes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const complete = yield* Deferred.make<void>();
    let calls = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      yield* service.stateStream.pipe(
        Stream.filter((state) => state.models[0]?.install._tag === "failed"),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* service.install({ model: "parakeet-v3" }).pipe(Effect.scoped);
      yield* Deferred.await(started);
      assert.strictEqual((yield* service.state).models[0]?.install._tag, "installing");
      yield* Deferred.succeed(complete, undefined);
      yield* service.stateStream.pipe(
        Stream.filter((state) => state.ready),
        Stream.take(1),
        Stream.runDrain,
      );
    }).pipe(
      Effect.provide(
        testLayer({
          installed: false,
          install: (model, progress) =>
            Effect.gen(function* () {
              calls++;
              if (calls === 1)
                return yield* new DictationError({
                  reason: "install-failed",
                  message: "Dictation installation failed.",
                });
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(complete);
              yield* progress("runtime", { _tag: "installed", sizeBytes: 1 });
              yield* progress(model, { _tag: "installed", sizeBytes: 1 });
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("a silent tail preserves the locale detected in earlier speech", () =>
  Effect.gen(function* () {
    const speechDecoded = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const { sessionId } = yield* service.start;
      yield* service.append({ sessionId, seq: 0, pcm: pcm(4) });
      yield* service.append({ sessionId, seq: 1, pcm: pcm(0.5, 0) });
      yield* Deferred.await(speechDecoded);
      yield* service.append({ sessionId, seq: 2, pcm: pcm(0.1, 0) });
      assert.deepStrictEqual(yield* service.finish({ sessionId, chunkCount: 3 }), {
        text: "hallo",
        locale: "nl",
      });
    }).pipe(
      Effect.provide(
        testLayer({
          localModel: "whisper-turbo",
          load: () =>
            Effect.succeed({
              decode: (samples) =>
                samples.some((sample) => sample !== 0)
                  ? Deferred.succeed(speechDecoded, undefined).pipe(
                      Effect.as({ text: "hallo", locale: "nl" }),
                    )
                  : Effect.succeed({ text: "", locale: "en" }),
              release: Effect.void,
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("turning off during cancellation prevents a stale replacement download", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const cancelling = yield* Deferred.make<void>();
    const cleanup = yield* Deferred.make<void>();
    const installs: DictationModelId[] = [];
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* Deferred.await(started);
      yield* settings.updateSettings({ dictation: { localModel: "moonshine-base" } });
      yield* Deferred.await(cancelling);
      yield* settings.updateSettings({ dictation: { engine: "off" } });
      yield* Deferred.succeed(cleanup, undefined);
      yield* service.stateStream.pipe(
        Stream.filter((state) => state.settings.engine === "off"),
        Stream.take(1),
        Stream.runDrain,
      );
      assert.deepStrictEqual(installs, ["parakeet-v3"]);
      assert.strictEqual((yield* service.state).models[2]?.install._tag, "not-installed");
    }).pipe(
      Effect.provide(
        testLayer({
          installed: false,
          install: (model) => {
            installs.push(model);
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(cancelling, undefined).pipe(
                  Effect.andThen(Deferred.await(cleanup)),
                ),
              ),
            );
          },
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("warm loads the model once before any recording, and is a no-op when off", () =>
  Effect.gen(function* () {
    let loads = 0;
    const load = () =>
      Effect.sync(() => {
        loads++;
        return {
          decode: () => Effect.succeed({ text: "one", locale: "en" }),
          release: Effect.void,
        };
      });
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      yield* service.warm;
      yield* service.warm;
      yield* Effect.yieldNow;
      assert.strictEqual((yield* service.state).loadedModel, "parakeet-v3");
      const { sessionId } = yield* service.start;
      yield* service.append({ sessionId, seq: 0, pcm: pcm(0.1) });
      yield* service.finish({ sessionId, chunkCount: 1 });
      assert.strictEqual(loads, 1);
    }).pipe(Effect.provide(testLayer({ load })), Effect.scoped);

    loads = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      yield* service.warm;
      yield* Effect.yieldNow;
      assert.strictEqual((yield* service.state).loadedModel, null);
      assert.strictEqual(loads, 0);
    }).pipe(Effect.provide(testLayer({ load, engine: "off" })), Effect.scoped);
  }),
);

it.effect("warm never installs a model while its removal is still deleting files", () =>
  Effect.gen(function* () {
    const removing = yield* Deferred.make<void>();
    const finishRemoval = yield* Deferred.make<void>();
    let removalPending = false;
    let installsDuringRemoval = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const settings = yield* ServerSettings.ServerSettingsService;
      const removal = yield* service.remove({ model: "moonshine-base" }).pipe(Effect.forkChild);
      yield* Deferred.await(removing);
      yield* settings.updateSettings({ dictation: { localModel: "moonshine-base" } });
      const warming = yield* service.warm.pipe(Effect.forkChild);
      for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
      yield* Deferred.succeed(finishRemoval, undefined);
      yield* Fiber.await(removal);
      yield* Fiber.await(warming);
      assert.strictEqual(installsDuringRemoval, 0);
    }).pipe(
      Effect.provide(
        testLayer({
          remove: () =>
            Effect.sync(() => {
              removalPending = true;
            }).pipe(
              Effect.andThen(Deferred.succeed(removing, undefined)),
              Effect.andThen(Deferred.await(finishRemoval)),
              Effect.ensuring(
                Effect.sync(() => {
                  removalPending = false;
                }),
              ),
            ),
          install: (model, progress) =>
            Effect.gen(function* () {
              if (removalPending) installsDuringRemoval++;
              yield* progress("runtime", { _tag: "installed", sizeBytes: 1 });
              yield* progress(model, { _tag: "installed", sizeBytes: 1 });
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("an unreadable install directory leaves dictation not installed instead of failing", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const state = yield* service.state;
    assert.strictEqual(state.runtime._tag, "not-installed");
    assert.strictEqual(state.ready, false);
  }).pipe(Effect.provide(testLayer({ engine: "off", inspectFails: true })), Effect.scoped),
);
