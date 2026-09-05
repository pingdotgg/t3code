// @effect-diagnostics nodeBuiltinImport:off - path joins mirror packaged native resources.
import { assert, describe, it } from "@effect/vitest";
import * as NodePath from "node:path";

import { pocketResourceError, pocketVoicePaths } from "./pocket-worker-client.ts";
import {
  nativeSpeechInterruptPolicy,
  createLatestSpeechQueue,
  interleavedAudioToMono,
  isNativeMicrophonePlatform,
  isNativeSpeechPlatform,
  isNativeSpeechReady,
  pocketIdleOffloadMs,
  nativeAudioPlaybackTimeoutMs,
  parakeetModelPaths,
  parakeetResourceError,
  parakeetSampleRate,
  playNativeCue,
  prepareNativeMicrophone,
  startParakeetCapture,
  startParakeetPcmCapture,
  normalizedAudioRms,
  type ParakeetCaptureDependencies,
  type NativeSpeechProcessDependencies,
} from "./native-speech.ts";

function parakeetHarness(options: { readonly blockModel?: boolean } = {}) {
  let onData: ((samples: Float32Array) => void) | undefined;
  let closeCount = 0;
  let decodeCount = 0;
  let decodedSamples: Float32Array = new Float32Array();
  let writtenWave:
    | { readonly path: string; readonly samples: Float32Array; readonly sampleRate: number }
    | undefined;
  let releaseModel: (() => void) | undefined;
  const modelReady = options.blockModel
    ? new Promise<void>((resolve) => {
        releaseModel = resolve;
      })
    : Promise.resolve();

  const microphone: ParakeetCaptureDependencies["microphone"] = {
    getHosts: () => [{ id: "wasapi", name: "WASAPI" }],
    getDevices: () => [],
    getDefaultInputDevice: () => ({
      name: "microphone",
      hostId: "wasapi",
      deviceId: "microphone",
      isDefaultInput: true,
      isDefaultOutput: false,
    }),
    getDefaultInputConfig: () => ({
      sampleRate: parakeetSampleRate,
      channels: 1,
      sampleFormat: "f32",
    }),
    createStream: (deviceId, isInput, _config, callback) => {
      assert.isTrue(isInput);
      onData = callback;
      return `${deviceId}:capture`;
    },
    closeStream: (stream) => {
      assert.equal(stream, "microphone:capture");
      closeCount += 1;
    },
  };

  const dependencies: ParakeetCaptureDependencies = {
    microphone,
    runtime: {
      OfflineRecognizer: {
        createAsync: async () => {
          await modelReady;
          return {
            createStream: () => ({
              acceptWaveform: ({ samples }) => {
                decodedSamples = samples;
              },
            }),
            decodeAsync: async () => {
              decodeCount += 1;
              return { text: "Review ripple" };
            },
          };
        },
      },
      LinearResampler: class {
        resample(samples: Float32Array) {
          return samples;
        }
        flush() {
          return new Float32Array();
        }
      },
      writeWave: (path, input) => {
        writtenWave = { path, ...input };
      },
    },
  };

  return {
    dependencies,
    emit: (samples: Float32Array) => onData?.(samples),
    closeCount: () => closeCount,
    decodeCount: () => decodeCount,
    decodedSamples: () => decodedSamples,
    writtenWave: () => writtenWave,
    releaseModel: () => releaseModel?.(),
  };
}

type FakeSpeechProcess = {
  killed: boolean;
  killSignal: string | undefined;
  stderr: {
    on(event: "data", listener: (chunk: unknown) => void): void;
    removeListener(event: "data", listener: (chunk: unknown) => void): void;
    emit(chunk: unknown): void;
  };
  once(event: "error" | "exit", listener: (...args: Array<unknown>) => void): void;
  removeListener(event: "error" | "exit", listener: (...args: Array<unknown>) => void): void;
  kill(signal?: string): boolean;
  emitExit(code: number | null): void;
  emitError(error: unknown): void;
};

function speechProcessHarness(
  outcomes: ReadonlyArray<"success" | "enoent" | "failure" | "hang">,
  stderr = "",
) {
  const spawned: Array<{ command: string; args: ReadonlyArray<string>; child: FakeSpeechProcess }> =
    [];
  let timeoutId = 0;
  const timers = new Map<number, () => void>();
  const makeChild = (): FakeSpeechProcess => {
    const listeners = new Map<string, Array<(...args: Array<unknown>) => void>>();
    const dataListeners: Array<(chunk: unknown) => void> = [];
    const child: FakeSpeechProcess = {
      killed: false,
      killSignal: undefined,
      stderr: {
        on: (_event, listener) => dataListeners.push(listener),
        removeListener: (_event, listener) => {
          const index = dataListeners.indexOf(listener);
          if (index >= 0) dataListeners.splice(index, 1);
        },
        emit: (chunk) => dataListeners.forEach((listener) => listener(chunk)),
      },
      once: (event, listener) => {
        const current = listeners.get(event) ?? [];
        listeners.set(event, [...current, listener]);
      },
      removeListener: (event, listener) => {
        const current = listeners.get(event) ?? [];
        listeners.set(
          event,
          current.filter((candidate) => candidate !== listener),
        );
      },
      kill: (signal) => {
        child.killed = true;
        child.killSignal = signal;
        return true;
      },
      emitExit: (code) => {
        for (const listener of listeners.get("exit") ?? []) listener(code, null);
      },
      emitError: (error) => {
        for (const listener of listeners.get("error") ?? []) listener(error);
      },
    };
    return child;
  };
  const dependencies: NativeSpeechProcessDependencies = {
    spawn: (command, args) => {
      const child = makeChild();
      const outcome = outcomes[spawned.length] ?? "failure";
      spawned.push({ command, args, child });
      if (stderr.length > 0) queueMicrotask(() => child.stderr.emit(stderr));
      if (outcome === "enoent") queueMicrotask(() => child.emitError({ code: "ENOENT" }));
      if (outcome === "success") queueMicrotask(() => child.emitExit(0));
      if (outcome === "failure") queueMicrotask(() => child.emitExit(1));
      return child;
    },
    setTimeout: (callback) => {
      const id = ++timeoutId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id as number),
  };
  return {
    dependencies,
    spawned,
    fireTimeout: () => timers.values().next().value?.(),
  };
}

describe("Parakeet capture", () => {
  it("normalizes PCM RMS levels for the listening waveform", () => {
    assert.equal(normalizedAudioRms(Float32Array.from([0.5, -0.5])), 0.5);
    assert.equal(normalizedAudioRms(Float32Array.from([2, -2])), 1);
    assert.equal(normalizedAudioRms(new Float32Array()), 0);
  });

  it("downmixes interleaved microphone channels before 16 kHz recognition", () => {
    assert.deepEqual(
      interleavedAudioToMono(Float32Array.from([1, -1, 0.5, 0.25]), 2),
      Float32Array.from([0, 0.375]),
    );
  });

  it("keeps the 110M INT8 model resident and decodes the full utterance only on release", async () => {
    const test = parakeetHarness({ blockModel: true });
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    let metrics:
      | {
          readonly engineId: "parakeet-tdt-ctc-110m-int8";
          readonly readyLatencyMs?: number;
          readonly firstTranscriptLatencyMs?: number;
          readonly finalLatencyMs: number;
          readonly cpuTimeMs: number;
          readonly peakRssBytes: number;
          readonly resourceBytes: number;
        }
      | undefined;
    let firstAudioFrameCount = 0;
    const capture = startParakeetCapture({
      paths: parakeetModelPaths("C:/Jarvis/parakeet"),
      dependencies: test.dependencies,
      platform: "win32",
      onReady: () => markReady?.(),
      onFirstAudioFrame: () => {
        firstAudioFrameCount += 1;
      },
      onMetrics: (value) => {
        metrics = value;
      },
      transformTranscript: (text) => text.replace("ripple", "Rivvl project"),
    });

    await ready;
    test.emit(Float32Array.from([0.1, -0.1, 0.2]));
    assert.equal(firstAudioFrameCount, 1);
    assert.equal(
      test.decodeCount(),
      0,
      "capture starts before the resident model finishes warming",
    );
    capture.release();
    assert.equal(test.decodeCount(), 0, "push-to-talk release is the segment boundary");
    test.releaseModel();

    assert.equal(await capture.result, "Review Rivvl project");
    assert.equal(test.decodeCount(), 1);
    assert.deepEqual(test.decodedSamples(), Float32Array.from([0.1, -0.1, 0.2]));
    assert.equal(test.closeCount(), 1);
    assert.isAtLeast(metrics?.readyLatencyMs ?? -1, 0);
    assert.isAtLeast(metrics?.firstTranscriptLatencyMs ?? -1, 0);
    assert.isAtLeast(metrics?.finalLatencyMs ?? -1, 0);
    assert.equal(metrics?.engineId, "parakeet-tdt-ctc-110m-int8");
    assert.isAtLeast(metrics?.cpuTimeMs ?? -1, 0);
    assert.isAbove(metrics?.peakRssBytes ?? 0, 0);
  });

  it("records the exact 16 kHz utterance only when development capture is enabled", async () => {
    const test = parakeetHarness();
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const capture = startParakeetCapture({
      paths: parakeetModelPaths("C:/Jarvis/parakeet"),
      dependencies: test.dependencies,
      platform: "win32",
      recordingDirectory: "C:/Jarvis/captures/42",
      onReady: () => markReady?.(),
    });
    await ready;
    test.emit(Float32Array.from([0.25]));
    capture.release();
    await capture.result;

    assert.deepEqual(test.writtenWave(), {
      path: NodePath.join("C:/Jarvis/captures/42", "capture.wav"),
      samples: Float32Array.from([0.25]),
      sampleRate: parakeetSampleRate,
    });
  });

  it("normalizes every complete utterance to 16 kHz", () => {
    assert.equal(parakeetSampleRate, 16_000);
  });

  it("limits native microphone capture to Windows and Linux", () => {
    assert.isTrue(isNativeMicrophonePlatform("linux"));
    assert.isTrue(isNativeMicrophonePlatform("win32"));
    assert.isFalse(isNativeMicrophonePlatform("darwin"));
    assert.doesNotThrow(() => prepareNativeMicrophone("darwin"));
    assert.throws(
      () =>
        startParakeetCapture({
          paths: parakeetModelPaths("/tmp/parakeet"),
          dependencies: parakeetHarness().dependencies,
          platform: "darwin",
        }),
      /Native Parakeet microphone capture is available on Windows and Linux only\./,
    );
  });

  it("reports a missing bundled model precisely", () => {
    const error = parakeetResourceError(parakeetModelPaths("/definitely/missing/parakeet"));
    assert.include(error?.message ?? "", "Parakeet encoder");
  });

  it("supports Linux capture through the injected native boundary", async () => {
    assert.isTrue(isNativeSpeechPlatform("linux"));
    const test = parakeetHarness();
    const capture = startParakeetCapture({
      paths: parakeetModelPaths("/tmp/parakeet"),
      dependencies: test.dependencies,
      platform: "linux",
    });
    test.emit(Float32Array.from([0.25]));
    capture.release();
    assert.equal(await capture.result, "Review ripple");
    assert.equal(test.closeCount(), 1);
  });

  it("feeds renderer PCM through the shared downmix and resample lifecycle", async () => {
    const test = parakeetHarness();
    let firstAudioFrameCount = 0;
    const levels: number[] = [];
    const capture = startParakeetPcmCapture({
      paths: parakeetModelPaths("/tmp/parakeet"),
      sampleRate: 48_000,
      channels: 2,
      platform: "darwin",
      dependencies: { runtime: test.dependencies.runtime },
      onReady: () => undefined,
      onFirstAudioFrame: () => {
        firstAudioFrameCount += 1;
      },
      onAudioLevel: (level) => levels.push(level),
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    capture.feed(Float32Array.from([1, -1, 0.5, 0.25]));
    capture.feed(Float32Array.from([0, 0]));
    capture.release();

    assert.equal(await capture.result, "Review ripple");
    assert.equal(firstAudioFrameCount, 1);
    assert.deepEqual(levels, [Math.sqrt(0.578125)]);
    assert.deepEqual(test.decodedSamples(), Float32Array.from([0, 0.375, 0]));
  });

  it("accepts renderer PCM fed immediately after construction", async () => {
    const test = parakeetHarness();
    const capture = startParakeetPcmCapture({
      paths: parakeetModelPaths("/tmp/parakeet"),
      sampleRate: 16_000,
      channels: 1,
      platform: "darwin",
      dependencies: { runtime: test.dependencies.runtime },
    });
    capture.feed(Float32Array.from([0.25]));
    capture.release();

    assert.equal(await capture.result, "Review ripple");
    assert.deepEqual(test.decodedSamples(), Float32Array.from([0.25]));
  });

  it("rejects a renderer session with stable no-frame and cancellation codes", async () => {
    const test = parakeetHarness();
    const empty = startParakeetPcmCapture({
      paths: parakeetModelPaths("/tmp/parakeet"),
      sampleRate: 16_000,
      channels: 1,
      platform: "darwin",
      dependencies: { runtime: test.dependencies.runtime },
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    empty.release();
    const emptyError = await empty.result.then(
      () => undefined,
      (error: { readonly code?: string }) => error,
    );
    assert.equal(emptyError?.code, "no-audio-frames");

    const cancelled = startParakeetPcmCapture({
      paths: parakeetModelPaths("/tmp/parakeet"),
      sampleRate: 16_000,
      channels: 1,
      platform: "darwin",
      dependencies: { runtime: test.dependencies.runtime },
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    cancelled.cancel();
    cancelled.feed(Float32Array.from([1]));
    const cancelledError = await cancelled.result.then(
      () => undefined,
      (error: { readonly code?: string }) => error,
    );
    assert.equal(cancelledError?.code, "cancelled");
  });
});

describe("Linux native WAV playback", () => {
  it("uses the first available direct player", async () => {
    const test = speechProcessHarness(["success"]);
    await playNativeCue("cue.wav", "linux", undefined, test.dependencies);

    assert.deepEqual(
      test.spawned.map(({ command, args }) => [command, args]),
      [["pw-play", ["cue.wav"]]],
    );
  });

  it("falls through ENOENT and nonzero exits", async () => {
    const test = speechProcessHarness(["enoent", "failure", "success"]);
    await playNativeCue("cue.wav", "linux", undefined, test.dependencies);

    assert.deepEqual(
      test.spawned.map(({ command, args }) => [command, args]),
      [
        ["pw-play", ["cue.wav"]],
        ["paplay", ["cue.wav"]],
        ["aplay", ["-q", "cue.wav"]],
      ],
    );
  });

  it("reports bounded stderr when every player fails", async () => {
    const stderr = "x".repeat(10_000);
    const test = speechProcessHarness(["failure", "enoent", "failure"], stderr);
    const failure = await playNativeCue("cue.wav", "linux", undefined, test.dependencies).catch(
      (cause: unknown) => cause,
    );

    assert.instanceOf(failure, Error);
    assert.isBelow((failure as Error).message.length, 20_000);
    assert.include((failure as Error).message, "no supported Linux audio player succeeded");
  });

  it("kills and waits for a child when the caller aborts", async () => {
    const controller = new AbortController();
    const test = speechProcessHarness(["hang"]);
    const playback = playNativeCue("cue.wav", "linux", controller.signal, test.dependencies);
    await Promise.resolve();
    controller.abort();
    test.spawned[0]?.child.emitExit(null);

    await playback;
    assert.isTrue(test.spawned[0]?.child.killed);
    assert.equal(test.spawned[0]?.child.killSignal, "SIGKILL");
  });

  it("kills and rejects on the playback timeout", async () => {
    const test = speechProcessHarness(["hang"]);
    const playback = playNativeCue("cue.wav", "linux", undefined, test.dependencies);
    await Promise.resolve();
    test.fireTimeout();
    test.spawned[0]?.child.emitExit(null);
    const failure = await playback.catch((cause: unknown) => cause);

    assert.instanceOf(failure, Error);
    assert.equal((failure as Error).message, "Jarvis voice playback took too long.");
    assert.isTrue(test.spawned[0]?.child.killed);
    assert.equal(test.spawned[0]?.child.killSignal, "SIGKILL");
  });
});

describe("macOS native WAV playback", () => {
  it("uses afplay for a completed cue", async () => {
    const test = speechProcessHarness(["success"]);
    await playNativeCue("cue.wav", "darwin", undefined, test.dependencies);

    assert.deepEqual(
      test.spawned.map(({ command, args }) => [command, args]),
      [["/usr/bin/afplay", ["cue.wav"]]],
    );
  });

  it("kills and waits for afplay when the caller aborts", async () => {
    const controller = new AbortController();
    const test = speechProcessHarness(["hang"]);
    const playback = playNativeCue("cue.wav", "darwin", controller.signal, test.dependencies);
    await Promise.resolve();
    controller.abort();
    test.spawned[0]?.child.emitExit(null);

    await playback;
    assert.isTrue(test.spawned[0]?.child.killed);
    assert.equal(test.spawned[0]?.child.killSignal, "SIGKILL");
  });

  it("surfaces afplay failures", async () => {
    const test = speechProcessHarness(["failure"], "device unavailable");
    const failure = await playNativeCue("cue.wav", "darwin", undefined, test.dependencies).catch(
      (cause: unknown) => cause,
    );

    assert.instanceOf(failure, Error);
    assert.include((failure as Error).message, "afplay");
    assert.include((failure as Error).message, "device unavailable");
  });
});

describe("Pocket voice runtime", () => {
  it("uses an idle safety window while active task retention owns residency", () => {
    assert.equal(pocketIdleOffloadMs, 300_000);
  });

  it("allows ordinary spoken reports to finish instead of killing playback after five seconds", () => {
    assert.isAtLeast(nativeAudioPlaybackTimeoutMs, 120_000);
  });

  it("uses the pinned Pocket voice bundle with the Alba reference", () => {
    const root = NodePath.join("jarvis", "pocket");
    const paths = pocketVoicePaths(root);
    assert.equal(paths.resourceRoot, root);
    assert.equal(paths.voiceFile, NodePath.join(root, "voices", "alba-casual-3s.wav"));
    assert.equal(paths.bundlePath, NodePath.join(root, "models", "bundle.json"));
  });

  it("reports missing bundled voice resources precisely", () => {
    const error = pocketResourceError(pocketVoicePaths("/definitely/missing/pocket"));
    assert.include(error?.message ?? "", "Pocket text conditioner");
  });

  it("gates native Pocket synthesis to supported local-speech platforms", () => {
    assert.isTrue(isNativeSpeechPlatform("linux"));
    assert.isTrue(isNativeSpeechPlatform("darwin"));
    assert.isFalse(isNativeSpeechReady("linux"));
  });

  it("keeps only the latest pending report while a sentence is speaking", async () => {
    const spoken: Array<string> = [];
    const complete: Array<() => void> = [];
    const queue = createLatestSpeechQueue(
      (text) =>
        new Promise<void>((resolve) => {
          spoken.push(text);
          complete.push(resolve);
        }),
    );

    const first = queue.enqueue("First report");
    const stale = queue.enqueue("Stale report");
    const latest = queue.enqueue("Latest report");

    assert.deepEqual(spoken, ["First report"]);
    complete.shift()?.();
    await first;
    await stale;
    assert.deepEqual(spoken, ["First report", "Latest report"]);

    complete.shift()?.();
    await latest;
  });

  it("reserves task acknowledgement ahead of a fast completion report", async () => {
    const spoken: Array<string> = [];
    const complete: Array<() => void> = [];
    const queue = createLatestSpeechQueue(
      (text) =>
        new Promise<void>((resolve) => {
          spoken.push(text);
          complete.push(resolve);
        }),
    );

    const acknowledgement = queue.reserve();
    const report = queue.enqueue("Task completed");
    assert.deepEqual(spoken, []);

    const acknowledged = acknowledgement.commit("On it");
    await Promise.resolve();
    assert.deepEqual(spoken, ["On it"]);

    complete.shift()?.();
    await acknowledged;
    assert.deepEqual(spoken, ["On it", "Task completed"]);

    complete.shift()?.();
    await report;
  });

  it("releases pending report speech when task acknowledgement is cancelled", async () => {
    const spoken: Array<string> = [];
    let finishReport: (() => void) | undefined;
    const queue = createLatestSpeechQueue(
      (text) =>
        new Promise<void>((resolve) => {
          spoken.push(text);
          finishReport = resolve;
        }),
    );

    const acknowledgement = queue.reserve();
    const report = queue.enqueue("Existing task completed");
    acknowledgement.cancel();
    await acknowledgement.commit("Must not be spoken");

    assert.deepEqual(spoken, ["Existing task completed"]);
    finishReport?.();
    await report;
  });

  it("interrupts current playback, drops the queued report, and can speak again", async () => {
    const spoken: Array<string> = [];
    const aborted: Array<string> = [];
    const resume: Array<() => void> = [];
    const queue = createLatestSpeechQueue(
      (text, signal) =>
        new Promise<void>((resolve) => {
          spoken.push(text);
          const settle = () => resolve();
          const onAbort = () => {
            aborted.push(text);
            settle();
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          resume.push(() => {
            signal.removeEventListener("abort", onAbort);
            settle();
          });
        }),
    );

    const first = queue.enqueue("First report");
    const stale = queue.enqueue("Stale queued report");
    assert.deepEqual(spoken, ["First report"]);
    assert.isTrue(queue.isActive());

    queue.interrupt();
    await first;
    await stale;
    assert.deepEqual(aborted, ["First report"]);
    assert.deepEqual(spoken, ["First report"]);
    assert.isFalse(queue.isActive());

    const next = queue.enqueue("Fresh report");
    assert.deepEqual(spoken, ["First report", "Fresh report"]);
    resume.at(-1)?.();
    await next;
    assert.isFalse(queue.isActive());
  });

  it("treats interruption as a completed speak so Host acknowledgement can proceed", () => {
    const overlay = nativeSpeechInterruptPolicy("overlay");
    const tray = nativeSpeechInterruptPolicy("tray");
    const capture = nativeSpeechInterruptPolicy("capture");
    const relay = nativeSpeechInterruptPolicy("relay");

    assert.isTrue(overlay.accepted);
    assert.isTrue(overlay.presentInterrupted);
    assert.isTrue(overlay.completeSpeak);
    assert.isTrue(tray.accepted);
    assert.isTrue(tray.completeSpeak);
    assert.isTrue(capture.accepted);
    assert.isFalse(capture.presentInterrupted);
    assert.isTrue(capture.completeSpeak);
    assert.isFalse(relay.accepted);
    assert.isTrue(relay.completeSpeak);
  });

  it("still fails a genuine playback error", async () => {
    const queue = createLatestSpeechQueue(async () => {
      throw new Error("playback failed");
    });
    const failure = await queue.enqueue("Broken report").catch((cause: unknown) => cause);
    assert.instanceOf(failure, Error);
    assert.equal((failure as Error).message, "playback failed");
  });
});
