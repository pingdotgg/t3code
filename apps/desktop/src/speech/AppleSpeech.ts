import type { DesktopAppleSpeechResult } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const SAMPLE_RATE = 16_000;
const MAX_PCM_BYTES = SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT * 5 * 60;
// Preparing a language for the first time downloads Apple's model.
const PREPARE_TIMEOUT = Duration.minutes(10);
const TRANSCRIBE_TIMEOUT = Duration.minutes(5);

const decodeOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ value: Schema.String })),
);

/** 16 kHz mono Float32 PCM to a 16-bit WAV that AVAudioFile reads. */
function encodeSpeechWav(pcmBytes: Uint8Array): Uint8Array {
  // Float32Array needs a 4-byte-aligned offset; copy a view that is not (Buffer.slice is a view).
  const aligned =
    pcmBytes.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0
      ? pcmBytes
      : new Uint8Array(pcmBytes);
  const samples = new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    aligned.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  const wav = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++)
      view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => {
    const clamped = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
    view.setInt16(44 + index * 2, Math.round(clamped * 0x7fff), true);
  });
  return wav;
}

export class AppleSpeech extends Context.Service<
  AppleSpeech,
  {
    readonly supportedLocales: Effect.Effect<readonly string[]>;
    readonly prepare: (locale: string) => Effect.Effect<DesktopAppleSpeechResult>;
    readonly transcribe: (
      locale: string,
      pcm: Uint8Array,
    ) => Effect.Effect<DesktopAppleSpeechResult>;
  }
>()("@t3tools/desktop/speech/AppleSpeech") {}

const unavailable: DesktopAppleSpeechResult = { ok: false, code: "unavailable" };
const failed: DesktopAppleSpeechResult = { ok: false, code: "failed" };

export const layer = Layer.effect(
  AppleSpeech,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostEnvironment = yield* HostProcess.Environment;
    const kernelRelease = yield* HostProcess.KernelRelease;

    let helper: string | undefined;
    // macOS 26 is Darwin 25, the helper's minimum deployment target.
    if (environment.platform === "darwin" && Number.parseInt(kernelRelease, 10) >= 25) {
      const candidate = environment.isPackaged
        ? environment.path.join(environment.resourcesPath, "apple-speech", "t3-apple-speech")
        : environment.path.join(
            environment.rootDir,
            "native",
            "apple-speech",
            "build",
            environment.processArch,
            "t3-apple-speech",
          );
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
        helper = candidate;
    }

    const run = (args: readonly string[], timeout: Duration.Input) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (helper === undefined) return unavailable;
          const handle = yield* spawner.spawn(
            ChildProcess.make(helper, args, { stdin: "ignore", env: hostEnvironment }),
          );
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          switch (Number(exitCode)) {
            case 0:
              return { ok: true, value: (yield* decodeOutput(stdout)).value } as const;
            case 2:
              return { ok: false, code: "unsupported-locale" } as const;
            case 3:
              return unavailable;
            default:
              yield* Effect.logWarning("Apple Speech helper failed", { exitCode, stderr });
              return failed;
          }
        }),
      ).pipe(
        // Leaving the scope kills a helper that outlives its timeout.
        Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.succeed(failed) }),
        Effect.catch((cause) =>
          Effect.logWarning("Apple Speech helper did not run", { cause }).pipe(Effect.as(failed)),
        ),
      );

    // Only a definite answer is kept; a slow or failed probe is asked again next time.
    let locales: readonly string[] | undefined;
    const supportedLocales = Effect.suspend(() =>
      locales === undefined
        ? run(["available"], Duration.seconds(10)).pipe(
            Effect.map((result) => {
              if (result.ok) locales = result.value.split(",").filter(Boolean);
              else if (result.code === "unavailable") locales = [];
              return locales ?? [];
            }),
          )
        : Effect.succeed(locales),
    );

    const pending = new Map<string, Effect.Effect<DesktopAppleSpeechResult>>();
    const preparePermit = yield* Semaphore.make(1);
    const getPendingPrepare = Effect.fn("AppleSpeech.getPendingPrepare")(function* (
      locale: string,
    ) {
      const existing = pending.get(locale);
      if (existing) return existing;
      const preparation = yield* Effect.cached(
        run(["prepare", locale], PREPARE_TIMEOUT).pipe(
          Effect.ensuring(Effect.sync(() => pending.delete(locale))),
        ),
      );
      pending.set(locale, preparation);
      return preparation;
    }, preparePermit.withPermits(1));

    return AppleSpeech.of({
      supportedLocales,
      prepare: Effect.fn("AppleSpeech.prepare")(function* (locale) {
        return yield* yield* getPendingPrepare(locale);
      }),
      transcribe: Effect.fn("AppleSpeech.transcribe")(function* (locale, pcm) {
        if (
          pcm.byteLength === 0 ||
          pcm.byteLength > MAX_PCM_BYTES ||
          pcm.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0
        )
          return failed;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.makeTempFileScoped({ suffix: ".wav" });
            yield* fileSystem.writeFile(file, encodeSpeechWav(pcm));
            return yield* run(["transcribe", locale, file], TRANSCRIBE_TIMEOUT);
          }),
        ).pipe(Effect.orElseSucceed(() => failed));
      }),
    });
  }),
);
