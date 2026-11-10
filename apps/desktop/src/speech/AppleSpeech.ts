import type { DesktopAppleSpeechResult } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const SAMPLE_RATE = 16_000;
const MAX_PCM_BYTES = SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT * 5 * 60;
// The first prepare for a language can download Apple's model.
const PREPARE_TIMEOUT = Duration.minutes(10);
const TRANSCRIBE_TIMEOUT = Duration.minutes(2);

const decodeOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ value: Schema.String })),
);

/** 16 kHz mono Float32 PCM to a 16-bit WAV that AVAudioFile reads. */
function encodeSpeechWav(pcmBytes: Uint8Array): Uint8Array {
  const samples = new Float32Array(
    pcmBytes.buffer,
    pcmBytes.byteOffset,
    pcmBytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
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
    readonly isAvailable: Effect.Effect<boolean>;
    readonly prepare: (locale: string) => Effect.Effect<DesktopAppleSpeechResult>;
    readonly transcribe: (
      locale: string,
      pcm: Uint8Array,
    ) => Effect.Effect<DesktopAppleSpeechResult>;
  }
>()("@t3tools/desktop/speech/AppleSpeech") {}

const unavailable: DesktopAppleSpeechResult = {
  ok: false,
  code: "unavailable",
  message: "Apple Speech needs the T3 Code desktop app on macOS 26 or later.",
};

export const layer = Layer.effect(
  AppleSpeech,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostEnvironment = yield* HostProcess.Environment;

    let helper: string | undefined;
    if (environment.platform === "darwin") {
      const relative = environment.path.join("apple-speech", "t3-apple-speech");
      const candidates = environment.isPackaged
        ? [environment.path.join(environment.resourcesPath, relative)]
        : [
            environment.path.join(
              environment.rootDir,
              "native",
              "apple-speech",
              "build",
              environment.processArch,
              "t3-apple-speech",
            ),
          ];
      for (const candidate of candidates) {
        if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
          helper = candidate;
          break;
        }
      }
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
          const message = stderr.trim() || "Apple Speech failed.";
          switch (Number(exitCode)) {
            case 0:
              return { ok: true, value: (yield* decodeOutput(stdout)).value } as const;
            case 2:
              return { ok: false, code: "unsupported-locale", message } as const;
            case 3:
              return unavailable;
            default:
              return { ok: false, code: "failed", message } as const;
          }
        }),
      ).pipe(
        // Leaving the scope kills a helper that outlives its timeout.
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.succeed<DesktopAppleSpeechResult>({
              ok: false,
              code: "failed",
              message: "Apple Speech did not respond.",
            }),
        }),
        Effect.catch((cause) =>
          Effect.succeed<DesktopAppleSpeechResult>({
            ok: false,
            code: "failed",
            message: cause instanceof Error ? cause.message : "Apple Speech failed.",
          }),
        ),
      );

    const isAvailable = yield* Effect.cached(
      run(["available"], Duration.seconds(10)).pipe(Effect.map((result) => result.ok)),
    );

    return AppleSpeech.of({
      isAvailable,
      prepare: Effect.fn("AppleSpeech.prepare")(function* (locale) {
        return yield* run(["prepare", locale], PREPARE_TIMEOUT);
      }),
      transcribe: Effect.fn("AppleSpeech.transcribe")(function* (locale, pcm) {
        if (
          pcm.byteLength === 0 ||
          pcm.byteLength > MAX_PCM_BYTES ||
          pcm.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0
        )
          return {
            ok: false,
            code: "failed",
            message: "The recording is empty or too long.",
          } as const;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.makeTempFileScoped({ suffix: ".wav" });
            yield* fileSystem.writeFile(file, encodeSpeechWav(pcm));
            return yield* run(["transcribe", locale, file], TRANSCRIBE_TIMEOUT);
          }),
        ).pipe(
          Effect.orElseSucceed((): DesktopAppleSpeechResult => ({
            ok: false,
            code: "failed",
            message: "Could not save the recording for Apple Speech.",
          })),
        );
      }),
    });
  }),
);
