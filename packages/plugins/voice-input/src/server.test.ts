// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFs from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { PluginId } from "@t3tools/plugin-api/schema";
import { PluginRuntimeError, type PluginActivationContext } from "@t3tools/plugin-api/server";
import {
  makePluginActivationTestHarness,
  type PluginActivationTestHarness,
} from "@t3tools/plugin-api/testing";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  VOICE_INPUT_COMMANDS,
  VOICE_INPUT_EVENTS,
  VOICE_INPUT_PLUGIN_ID,
} from "./shared/constants.ts";
import type { VoiceInputDependenciesStatusResult } from "./shared/schema.ts";
import { getModelDownloadBlockedReason } from "./shared/settings.ts";
import {
  fasterWhisperInstallCommand,
  formatFasterWhisperUnavailableDetail,
  localWhisperVenvPythonCommand,
  localWhisperVenvSetupCommand,
  pythonCommandInvocation,
} from "./server/dependencies.ts";
import { voiceInputPlugin } from "./server/index.ts";
import { transcribeWithLocalWhisper } from "./server/localWhisper.ts";
import { withTempAudioFile } from "./server/tempAudio.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function makeHarness(paths: PluginActivationContext["paths"]): PluginActivationTestHarness {
  return makePluginActivationTestHarness({
    pluginId: PluginId.make(VOICE_INPUT_PLUGIN_ID),
    paths,
    createAndSendThread: () => Effect.fail(new PluginRuntimeError("Unexpected runtime call.")),
  });
}

it.effect("Voice Input plugin registers manifest, collections, and settings commands", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFs.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-voice-input-test-")),
    );
    const harness = makeHarness({
      dataDir: NodePath.join(root, "data"),
      cacheDir: NodePath.join(root, "cache"),
      tempDir: NodePath.join(root, "temp"),
    });

    yield* voiceInputPlugin.activate(harness.ctx);

    assert.equal(voiceInputPlugin.manifest.id, PluginId.make(VOICE_INPUT_PLUGIN_ID));
    assert.equal(voiceInputPlugin.manifest.ui.composerActions?.[0]?.id, "voice-input");
    assert.isTrue(harness.commands.has(VOICE_INPUT_COMMANDS.settingsGet));
    assert.isTrue(harness.commands.has(VOICE_INPUT_COMMANDS.settingsUpdate));

    const getCommand = harness.commands.get(VOICE_INPUT_COMMANDS.settingsGet);
    assert.isDefined(getCommand);
    const initial = (yield* getCommand.invoke({})) as {
      settings: { model: string; pythonCommand: string };
    };
    assert.equal(initial.settings.model, "base");
    assert.equal(initial.settings.pythonCommand, "");

    const updateCommand = harness.commands.get(VOICE_INPUT_COMMANDS.settingsUpdate);
    assert.isDefined(updateCommand);
    const updated = (yield* updateCommand.invoke({
      patch: { model: "tiny", pythonCommand: "/tmp/voice-input/bin/python" },
    })) as {
      settings: { model: string; pythonCommand: string };
    };
    assert.equal(updated.settings.model, "tiny");
    assert.equal(updated.settings.pythonCommand, "/tmp/voice-input/bin/python");
    assert.deepEqual(harness.publishedEvents.at(-1), {
      type: VOICE_INPUT_EVENTS.changed,
      payload: { settings: true },
    });
  }),
);

it.effect("normalizes legacy settings with the default Python executable setting", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFs.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-voice-input-legacy-settings-test-")),
    );
    const harness = makeHarness({
      dataDir: NodePath.join(root, "data"),
      cacheDir: NodePath.join(root, "cache"),
      tempDir: NodePath.join(root, "temp"),
    });

    yield* voiceInputPlugin.activate(harness.ctx);
    harness.rawDocuments.get("settings")?.set("default", {
      enabled: true,
      provider: "localWhisper",
      model: "base",
      language: "auto",
      device: "auto",
      maxRecordingSeconds: 120,
      maxUploadBytes: 25 * 1024 * 1024,
      transcriptionTimeoutSeconds: 120,
      promptHint: "",
    });

    const getCommand = harness.commands.get(VOICE_INPUT_COMMANDS.settingsGet);
    assert.isDefined(getCommand);
    const result = (yield* getCommand.invoke({})) as { settings: { pythonCommand: string } };
    assert.equal(result.settings.pythonCommand, "");
  }),
);

it.effect("temporary audio files are deleted after use", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFs.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-voice-input-audio-test-")),
    );
    let capturedPath = "";
    const result = yield* Effect.promise(() =>
      withTempAudioFile(
        root,
        {
          audioBase64: Buffer.from("audio").toString("base64"),
          mimeType: "audio/webm;codecs=opus",
          sizeBytes: Buffer.byteLength("audio"),
        },
        async (audioPath) => {
          capturedPath = audioPath;
          const contents = await NodeFs.readFile(audioPath, "utf8");
          assert.equal(contents, "audio");
          return "ok";
        },
      ),
    );

    assert.equal(result, "ok");
    const accessExit = yield* Effect.exit(Effect.promise(() => NodeFs.access(capturedPath)));
    assert.equal(accessExit._tag, "Failure");
  }),
);

it.effect("temporary audio files reject malformed base64 payloads", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFs.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-voice-input-audio-invalid-test-")),
    );
    const invalidPayload = `${Buffer.from("audio").toString("base64")}$`;

    const exit = yield* Effect.exit(
      Effect.promise(() =>
        withTempAudioFile(
          root,
          {
            audioBase64: invalidPayload,
            mimeType: "audio/webm;codecs=opus",
            sizeBytes: Buffer.byteLength("audio"),
          },
          async () => "unexpected",
        ),
      ),
    );

    assert.equal(exit._tag, "Failure");
  }),
);

it.effect("rejects overlapping transcriptions instead of queueing Whisper processes", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFs.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-voice-input-concurrency-test-")),
    );
    const markerPath = NodePath.join(root, "transcribe-started");
    const releasePath = NodePath.join(root, "transcribe-release");
    const pythonCommandPath = NodePath.join(root, "fake-python.sh");
    yield* Effect.promise(() =>
      NodeFs.writeFile(
        pythonCommandPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then echo \'Python 3.12.0\'; exit 0; fi',
          'if [ "$1" = "-c" ]; then exit 0; fi',
          'if [ "$2" = "transcribe" ]; then',
          `  touch ${shellQuote(markerPath)}`,
          `  while [ ! -f ${shellQuote(releasePath)} ]; do sleep 0.05; done`,
          '  printf \'{"text":"hello","language":"en"}\'',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
      ),
    );
    yield* Effect.promise(() => NodeFs.chmod(pythonCommandPath, 0o755));
    const harness = makeHarness({
      dataDir: NodePath.join(root, "data"),
      cacheDir: NodePath.join(root, "cache"),
      tempDir: NodePath.join(root, "temp"),
    });

    yield* voiceInputPlugin.activate(harness.ctx);
    const updateCommand = harness.commands.get(VOICE_INPUT_COMMANDS.settingsUpdate);
    const transcribeCommand = harness.commands.get(VOICE_INPUT_COMMANDS.transcribe);
    assert.isDefined(updateCommand);
    assert.isDefined(transcribeCommand);
    yield* updateCommand.invoke({ patch: { pythonCommand: pythonCommandPath } });
    const input = {
      audioBase64: Buffer.from("audio").toString("base64"),
      mimeType: "audio/webm",
      sizeBytes: Buffer.byteLength("audio"),
    };

    const first = yield* transcribeCommand.invoke(input).pipe(Effect.forkScoped);
    let firstStarted = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      firstStarted = yield* Effect.promise(() =>
        NodeFs.access(markerPath).then(
          () => true,
          () => false,
        ),
      );
      if (firstStarted) break;
      yield* Effect.promise(() => delay(25));
    }
    assert.isTrue(firstStarted);

    const releaseFirst = yield* Effect.promise(() =>
      delay(100).then(() => NodeFs.writeFile(releasePath, "release", "utf8")),
    ).pipe(Effect.forkScoped);
    const second = yield* Effect.exit(transcribeCommand.invoke(input));
    yield* Fiber.join(releaseFirst);
    yield* Fiber.join(first);
    assert.equal(second._tag, "Failure");
    if (second._tag === "Failure") {
      assert.include(String(second.cause), "Voice transcription is already running.");
    }
  }),
);

it.effect("waits for interrupted Whisper helper processes to close", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFs.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-voice-input-helper-interrupt-test-")),
    );
    const markerPath = NodePath.join(root, "helper-started");
    const terminatedPath = NodePath.join(root, "helper-terminated");
    const closedPath = NodePath.join(root, "helper-closed");
    const audioPath = NodePath.join(root, "input.webm");
    const pythonCommandPath = NodePath.join(root, "fake-python.sh");
    yield* Effect.promise(() => NodeFs.writeFile(audioPath, "audio"));
    yield* Effect.promise(() =>
      NodeFs.writeFile(
        pythonCommandPath,
        [
          "#!/bin/sh",
          `trap "touch ${shellQuote(terminatedPath)}; sleep 0.2; touch ${shellQuote(closedPath)}; exit 0" TERM`,
          'if [ "$2" = "transcribe" ]; then',
          `  touch ${shellQuote(markerPath)}`,
          "  while true; do sleep 0.05; done",
          "fi",
          "exit 0",
        ].join("\n"),
      ),
    );
    yield* Effect.promise(() => NodeFs.chmod(pythonCommandPath, 0o755));

    const fiber = yield* transcribeWithLocalWhisper({
      pythonCommand: pythonCommandPath,
      cacheDir: root,
      audioPath,
      settings: {
        enabled: true,
        provider: "localWhisper",
        model: "base",
        language: "auto",
        device: "auto",
        pythonCommand: pythonCommandPath,
        maxRecordingSeconds: 120,
        maxUploadBytes: 25 * 1024 * 1024,
        transcriptionTimeoutSeconds: 120,
        promptHint: "",
      },
    }).pipe(Effect.forkScoped);

    let helperStarted = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      helperStarted = yield* Effect.promise(() =>
        NodeFs.access(markerPath).then(
          () => true,
          () => false,
        ),
      );
      if (helperStarted) break;
      yield* Effect.promise(() => delay(25));
    }
    assert.isTrue(helperStarted);

    yield* Fiber.interrupt(fiber);
    const terminated = yield* Effect.promise(() =>
      NodeFs.access(terminatedPath).then(
        () => true,
        () => false,
      ),
    );
    const closed = yield* Effect.promise(() =>
      NodeFs.access(closedPath).then(
        () => true,
        () => false,
      ),
    );
    assert.isTrue(terminated);
    assert.isTrue(closed);
  }),
);

it("formats faster-whisper setup guidance without leaking Python tracebacks", () => {
  assert.equal(
    fasterWhisperInstallCommand("python3"),
    "python3 -m pip install --upgrade faster-whisper",
  );
  assert.equal(
    fasterWhisperInstallCommand("py -3"),
    "py -3 -m pip install --upgrade faster-whisper",
  );
  assert.deepEqual(pythonCommandInvocation("py -3"), {
    executable: "py",
    args: ["-3"],
  });
  assert.equal(
    formatFasterWhisperUnavailableDetail("python3"),
    "faster-whisper is not installed for python3. Install with: python3 -m pip install --upgrade faster-whisper",
  );
  assert.include(
    localWhisperVenvSetupCommand("/tmp/t3 voice"),
    localWhisperVenvPythonCommand("/tmp/t3 voice"),
  );
});

it("blocks model download until Local Whisper dependencies are ready", () => {
  const missingFasterWhisper = {
    python: { available: true, detail: "Python 3.12.3" },
    venvPython: { available: false, detail: "Configured Python executable could not be run." },
    fasterWhisper: {
      available: false,
      detail:
        "faster-whisper is not installed for python3. Install with: python3 -m pip install --upgrade faster-whisper",
    },
    ffmpeg: { available: false, detail: "ffmpeg was not found on PATH." },
    selectedModelCached: false,
    cachePath: "/tmp/models",
    installCommand:
      "python3 -m venv /tmp/venv && /tmp/venv/bin/python -m pip install faster-whisper",
    venvPath: "/tmp/venv",
    venvPythonCommand: "/tmp/venv/bin/python",
    venvSetupCommand:
      "python3 -m venv /tmp/venv && /tmp/venv/bin/python -m pip install faster-whisper",
  } satisfies VoiceInputDependenciesStatusResult;

  assert.equal(
    getModelDownloadBlockedReason(missingFasterWhisper, false),
    "faster-whisper is not installed for python3. Install with: python3 -m pip install --upgrade faster-whisper",
  );
  assert.equal(
    getModelDownloadBlockedReason(
      { ...missingFasterWhisper, fasterWhisper: { available: true } },
      true,
    ),
    "Save Voice Input settings before downloading the selected model.",
  );
  assert.equal(
    getModelDownloadBlockedReason(
      { ...missingFasterWhisper, fasterWhisper: { available: true } },
      false,
    ),
    null,
  );
});
