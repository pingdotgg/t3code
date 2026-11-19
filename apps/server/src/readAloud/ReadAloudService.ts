// @effect-diagnostics effectFnOpportunity:off nodeBuiltinImport:off - Thin wrapper over child processes; spans come from withSpan.
import * as NodeChildProcess from "node:child_process";

import {
  ReadAloudError,
  type ReadAloudEngine,
  type ReadAloudSpeakInput,
  type ReadAloudStatus,
  type ReadAloudVoice,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  limitVoices,
  parseMacVoices,
  parseSpeechDispatcherVoices,
  parseWindowsVoices,
  speakCommand,
} from "./readAloudCore.ts";

/**
 * Speaks text with the host's own speech engine: speech-dispatcher on Linux, `say` on macOS, and
 * SAPI on Windows. One utterance plays at a time; a new one or a stop ends the current one.
 */
export class ReadAloudService extends Context.Service<
  ReadAloudService,
  {
    readonly status: Effect.Effect<ReadAloudStatus, ReadAloudError>;
    readonly speak: (
      input: ReadAloudSpeakInput,
    ) => Effect.Effect<{ readonly completed: boolean }, ReadAloudError>;
    readonly stop: Effect.Effect<void>;
  }
>()("t3/readAloud/ReadAloudService") {}

function run(command: string, args: ReadonlyArray<string>, timeoutMs = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

async function detect(platform: NodeJS.Platform): Promise<ReadAloudStatus> {
  if (platform === "darwin") {
    const voices = parseMacVoices(await run("say", ["-v", "?"]).catch(() => ""));
    return { engine: "macos-say", voices: limitVoices(voices), note: null };
  }
  if (platform === "win32") {
    const script =
      "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }";
    const output = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]).catch(() => null);
    if (output === null) {
      return { engine: null, voices: [], note: "Windows speech (SAPI) is not available." };
    }
    return { engine: "windows-sapi", voices: limitVoices(parseWindowsVoices(output)), note: null };
  }
  const modules = await run("spd-say", ["-O"]).catch(() => null);
  if (modules === null) {
    return {
      engine: null,
      voices: [],
      note: "Install speech-dispatcher and a voice (espeak-ng, or Piper for natural voices) to read aloud on this machine.",
    };
  }
  const voices: ReadAloudVoice[] = [];
  for (const module of modules
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)) {
    const listing = await run("spd-say", ["-o", module, "-L"]).catch(() => "");
    voices.push(...parseSpeechDispatcherVoices(module, listing));
  }
  return {
    engine: "speech-dispatcher",
    voices: limitVoices(voices),
    note: voices.some((voice) => voice.module === "piper" || voice.module === "rhvoice")
      ? null
      : "For more natural voices, add Piper or RHVoice to speech-dispatcher.",
  };
}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  let cached: Promise<ReadAloudStatus> | null = null;
  let current: { child: NodeChildProcess.ChildProcess; engine: ReadAloudEngine } | null = null;

  const stopCurrent = () => {
    const playing = current;
    current = null;
    if (playing === null) return;
    playing.child.kill();
    // spd-say exits on kill, but the daemon keeps speaking what it already queued.
    if (playing.engine === "speech-dispatcher") {
      NodeChildProcess.execFile("spd-say", ["-C"], () => undefined);
    }
  };

  const status = Effect.tryPromise({
    try: () => (cached ??= detect(platform)),
    catch: (cause) =>
      new ReadAloudError({ message: `Could not read the speech engine: ${String(cause)}` }),
  }).pipe(Effect.withSpan("ReadAloudService.status"));

  return ReadAloudService.of({
    status,
    speak: Effect.fn("ReadAloudService.speak")(function* (input) {
      const { engine } = yield* status;
      if (engine === null) {
        return yield* new ReadAloudError({ message: "This machine has no speech engine." });
      }
      stopCurrent();
      if (input.text.trim() === "") return { completed: true };
      const { command, args } = speakCommand(engine, input);
      return yield* Effect.callback<{ readonly completed: boolean }, ReadAloudError>((resume) => {
        const child = NodeChildProcess.spawn(command, args, {
          stdio: ["pipe", "ignore", "ignore"],
          windowsHide: true,
        });
        const entry = { child, engine };
        current = entry;
        child.on("error", (error) => {
          if (current === entry) current = null;
          resume(Effect.fail(new ReadAloudError({ message: `Speech failed: ${error.message}` })));
        });
        child.on("exit", () => {
          const completed = current === entry;
          if (completed) current = null;
          resume(Effect.succeed({ completed }));
        });
        child.stdin?.end(input.text);
        return Effect.sync(() => {
          if (current === entry) stopCurrent();
        });
      });
    }),
    stop: Effect.sync(stopCurrent).pipe(Effect.withSpan("ReadAloudService.stop")),
  });
});

export const layer = Layer.effect(ReadAloudService, make);
