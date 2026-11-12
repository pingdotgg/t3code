import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as AppleSpeech from "./AppleSpeech.ts";

const encoder = new TextEncoder();
const text = (value: string) => (value ? Stream.make(encoder.encode(value)) : Stream.empty);

type HelperOutput = {
  stdout?: string;
  stderr?: string;
  exitCode: number;
  exit?: Deferred.Deferred<void>;
};

function makeProcess(result: HelperOutput) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    stdout: text(result.stdout ?? ""),
    stderr: text(result.stderr ?? ""),
    all: Stream.empty,
    exitCode: (result.exit ? Deferred.await(result.exit) : Effect.void).pipe(
      Effect.as(ChildProcessSpawner.ExitCode(result.exitCode)),
    ),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function setup(result: HelperOutput) {
  const commands: Array<ReadonlyArray<string>> = [];
  const written: Uint8Array[] = [];
  const layer = AppleSpeech.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: "darwin",
          isPackaged: true,
          resourcesPath: "/app/Resources",
          path: { join: (...parts: string[]) => parts.join("/") },
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        FileSystem.layerNoop({
          exists: () => Effect.succeed(true),
          makeTempFileScoped: () => Effect.succeed("/tmp/recording.wav"),
          writeFile: (_path, data) => Effect.sync(() => void written.push(data)),
        }),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const { command: executable, args } = command as unknown as {
              command: string;
              args: ReadonlyArray<string>;
            };
            commands.push([executable, ...args]);
            return Effect.succeed(makeProcess(result));
          }),
        ),
      ),
    ),
  );
  return { commands, written, layer };
}

describe("AppleSpeech", () => {
  it.effect.each([
    [
      { stdout: '{"value":"en-US"}', exitCode: 0 },
      { ok: true, value: "en-US" },
    ],
    [
      { stderr: "Locale not supported: xx\n", exitCode: 2 },
      { ok: false, code: "unsupported-locale", message: "Locale not supported: xx" },
    ],
    [{ exitCode: 3 }, { ok: false, code: "unavailable" }],
    [
      { stderr: "boom", exitCode: 1 },
      { ok: false, code: "failed", message: "boom" },
    ],
    [
      { stdout: "not json", exitCode: 0 },
      { ok: false, code: "failed" },
    ],
  ] as const)(
    "maps helper output %j to %j, preparing again only after a failure",
    ([output, expected]) => {
      const { layer, commands } = setup(output);
      return Effect.gen(function* () {
        const speech = yield* AppleSpeech.AppleSpeech;
        assert.deepInclude(yield* speech.prepare("en-US"), expected);
        assert.deepInclude(yield* speech.prepare("en-US"), expected);
        const command = ["/app/Resources/apple-speech/t3-apple-speech", "prepare", "en-US"];
        assert.deepEqual(commands, expected.ok ? [command] : [command, command]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("shares one helper between prepares that start while the first is running", () =>
    Effect.gen(function* () {
      const exit = yield* Deferred.make<void>();
      const { layer, commands } = setup({ stdout: '{"value":"en-US"}', exitCode: 0, exit });
      return yield* Effect.gen(function* () {
        const speech = yield* AppleSpeech.AppleSpeech;
        const first = yield* speech
          .prepare("en-US")
          .pipe(Effect.forkChild({ startImmediately: true }));
        const second = yield* speech
          .prepare("en-US")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(exit, undefined);
        assert.deepEqual(yield* Fiber.join(first), { ok: true, value: "en-US" });
        assert.deepEqual(yield* Fiber.join(second), { ok: true, value: "en-US" });
        assert.lengthOf(commands, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect.each([
    [0, true, 1],
    [3, false, 1],
    [1, false, 2],
  ] as const)(
    "isAvailable with helper exit %i is %s and probes %i time(s) for two calls",
    ([exitCode, expected, probes]) => {
      const { layer, commands } = setup({ stdout: '{"value":""}', exitCode });
      return Effect.gen(function* () {
        const speech = yield* AppleSpeech.AppleSpeech;
        assert.equal(yield* speech.isAvailable, expected);
        assert.equal(yield* speech.isAvailable, expected);
        assert.lengthOf(commands, probes);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("transcribes Float32 PCM through a 16-bit WAV file", () => {
    const { layer, commands, written } = setup({ stdout: '{"value":"hello"}', exitCode: 0 });
    // An unaligned view, as a structured-clone or subarray caller may pass.
    const pcm = new Uint8Array(17);
    new DataView(pcm.buffer).setFloat32(1, 0, true);
    new DataView(pcm.buffer).setFloat32(5, 1, true);
    new DataView(pcm.buffer).setFloat32(9, -1, true);
    new DataView(pcm.buffer).setFloat32(13, 2, true);
    return Effect.gen(function* () {
      const result = yield* (yield* AppleSpeech.AppleSpeech).transcribe("en-US", pcm.subarray(1));
      assert.deepEqual(result, { ok: true, value: "hello" });
      assert.deepEqual(commands, [
        [
          "/app/Resources/apple-speech/t3-apple-speech",
          "transcribe",
          "en-US",
          "/tmp/recording.wav",
        ],
      ]);
      const wav = new DataView(written[0]!.buffer);
      assert.equal(new TextDecoder().decode(written[0]!.subarray(0, 4)), "RIFF");
      assert.equal(wav.getUint16(20, true), 1);
      assert.equal(wav.getUint32(24, true), 16_000);
      assert.equal(wav.getUint16(34, true), 16);
      assert.equal(wav.getUint32(40, true), 8);
      assert.deepEqual(
        [0, 1, 2, 3].map((index) => wav.getInt16(44 + index * 2, true)),
        [0, 32767, -32767, 32767],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects PCM that is not whole Float32 samples without running the helper", () => {
    const { layer, commands } = setup({ exitCode: 0 });
    return Effect.gen(function* () {
      const result = yield* (yield* AppleSpeech.AppleSpeech).transcribe("en-US", new Uint8Array(3));
      assert.deepInclude(result, { ok: false, code: "failed" });
      assert.lengthOf(commands, 0);
    }).pipe(Effect.provide(layer));
  });
});
