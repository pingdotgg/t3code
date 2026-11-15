import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { AUDIO_CPP_VERSION } from "@t3tools/audio-cpp";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { expect, vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as LocalSpeechSynthesis from "./LocalSpeechSynthesis.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";

/** Runs `body` against the service with an extracted runtime, so installs download only the model. */
const withService = <A, E>(
  store: Partial<SpeechModelStore.SpeechModelStore["Service"]>,
  body: (
    service: LocalSpeechSynthesis.LocalSpeechSynthesis["Service"],
  ) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtime = path.join(
      config.stateDir,
      "speech",
      "runtime",
      `audio-cpp-${AUDIO_CPP_VERSION}-darwin-arm64`,
      "metal",
    );
    yield* fs.makeDirectory(path.join(runtime, "libs"), { recursive: true });
    yield* fs.writeFileString(path.join(runtime, ".t3-complete"), AUDIO_CPP_VERSION);
    yield* fs.writeFileString(path.join(runtime, "libs", "libaudiocpp.0.1.0.dylib"), "");
    return yield* body(yield* LocalSpeechSynthesis.LocalSpeechSynthesis);
  }).pipe(
    Effect.provide(
      LocalSpeechSynthesis.layer.pipe(
        Layer.provide(
          Layer.mock(SpeechModelStore.SpeechModelStore)({
            isReady: () => Effect.succeed(false),
            ...store,
          }),
        ),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-local-speech-" })),
        Layer.provide(SecureRandom.layerWebCrypto),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Architecture, "arm64"),
  );

it.effect("joins a second download of the same model instead of starting another install", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const download = vi.fn(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as("/unused"),
      ),
    );
    yield* withService({ download }, (service) =>
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(service.download("supertonic-3"));
        const second = yield* Effect.forkChild(service.download("supertonic-3"));
        yield* Deferred.await(started);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(download).toHaveBeenCalledTimes(1);
      }),
    );
  }),
);

it.effect("refuses a download while a removal deletes the shared runtime", () =>
  Effect.gen(function* () {
    const removing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const download = vi.fn(() => Effect.succeed("/unused"));
    yield* withService(
      {
        download,
        remove: () =>
          Deferred.succeed(removing, undefined).pipe(Effect.andThen(Deferred.await(release))),
      },
      (service) =>
        Effect.gen(function* () {
          const removal = yield* Effect.forkChild(service.remove("supertonic-3"));
          yield* Deferred.await(removing);
          expect(yield* Effect.flip(service.download("supertonic-3"))).toMatchObject({
            reason: "busy",
          });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(removal);
          expect(download).not.toHaveBeenCalled();
        }),
    );
  }),
);
