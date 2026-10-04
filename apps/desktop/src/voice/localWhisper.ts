// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// Timers here bound native child-process lifetime and are cleared on its close event.
// This module is lazy-loaded by the desktop IPC boundary. Inference always runs
// in a cancellable child process, never in Electron's main or renderer thread.
import * as NodeTimers from "node:timers";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { DesktopDictationInput, DesktopDictationResult } from "@t3tools/contracts";

export const WHISPER_MODEL = {
  name: "Whisper tiny (multilingual)",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
  file: "ggml-tiny.bin",
  maxBytes: 100 * 1024 * 1024,
  // Upstream models/README.md, blob 6ee78664501cf3f305130fcbd682af2d99861d94.
  sha1: "bd577a113a864445d4c299885e0cb97d4ba92b5f",
};
export function validateDictationWav(audio: Uint8Array): void {
  if (audio.byteLength < 46 || audio.byteLength > 16_000 * 2 * 300 + 44)
    throw new Error("Recording must contain 16 kHz mono audio, up to five minutes long.");
  const bytes = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const ascii = (start: number, length: number) =>
    new TextDecoder().decode(audio.slice(start, start + length));
  if (
    ascii(0, 4) !== "RIFF" ||
    ascii(8, 4) !== "WAVE" ||
    ascii(12, 4) !== "fmt " ||
    bytes.getUint32(16, true) !== 16 ||
    bytes.getUint16(20, true) !== 1 ||
    bytes.getUint16(22, true) !== 1 ||
    bytes.getUint32(24, true) !== 16000 ||
    bytes.getUint16(34, true) !== 16 ||
    ascii(36, 4) !== "data" ||
    bytes.getUint32(40, true) !== audio.byteLength - 44
  )
    throw new Error("Recording has an unsupported audio format.");
}
export function runWhisperProcess(
  executable: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const child = NodeChildProcess.spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let failure: Error | null = null;
    let killTimer: ReturnType<typeof NodeTimers.setTimeout> | undefined;
    const stop = () => {
      if (killTimer) return;
      child.kill();
      killTimer = NodeTimers.setTimeout(() => child.kill("SIGKILL"), 1500);
    };
    const abort = () => {
      failure = new Error("Cancelled");
      stop();
    };
    const deadline = NodeTimers.setTimeout(() => {
      failure = new Error("Local transcription timed out. Try a shorter recording.");
      stop();
    }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    const collect = (data: Buffer) => {
      if (output.length < 64_000) output += data.toString().slice(0, 64_000 - output.length);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => {
      failure = new Error(
        "Could not start whisper-cli. Install a compatible build and check the executable path.",
      );
    });
    child.on("close", (code) => {
      NodeTimers.clearTimeout(deadline);
      if (killTimer) NodeTimers.clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error("whisper-cli failed. Check the installed build, model, and available memory."),
        );
      else resolve(output);
    });
  });
}
export class LocalWhisper {
  private state: DesktopDictationResult = {
    state: "missing-model",
    message: "Install the local model to enable dictation.",
    downloadedBytes: 0,
    totalBytes: 0,
  };
  private active: {
    owner: number;
    id: string;
    abort: AbortController;
    done: Promise<void>;
  } | null = null;
  private verifiedModel = false;
  private probedExecutable: string | null = null;
  private readonly directory: string;
  private readonly platform: string;
  private readonly fetchModel: (url: string, init?: RequestInit) => Promise<Response>;
  constructor(
    directory: string,
    platform: string,
    fetchModel: (url: string, init?: RequestInit) => Promise<Response>,
  ) {
    this.directory = directory;
    this.platform = platform;
    this.fetchModel = fetchModel;
  }
  cancelOwner(owner: number) {
    if (this.active?.owner === owner) this.active.abort.abort();
  }
  async dispose() {
    const operation = this.active;
    operation?.abort.abort();
    await operation?.done;
  }
  private async executable(configured: string): Promise<string | null> {
    const candidates = configured
      ? [configured]
      : this.platform === "darwin"
        ? ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]
        : ["whisper-cli"];
    for (const candidate of candidates) {
      if (candidate === this.probedExecutable) return candidate;
      try {
        const help = await runWhisperProcess(
          candidate,
          ["--help"],
          new AbortController().signal,
          5000,
        );
        if (!/whisper|usage:/i.test(help)) continue;
        this.probedExecutable = candidate;
        return candidate;
      } catch {
        /* The status response explains the required local installation. */
      }
    }
    return null;
  }
  private async verify(): Promise<boolean> {
    if (this.verifiedModel) return true;
    try {
      const hash = NodeCrypto.createHash("sha1");
      for await (const chunk of NodeFS.createReadStream(
        NodePath.join(this.directory, WHISPER_MODEL.file),
      ))
        hash.update(chunk);
      this.verifiedModel = hash.digest("hex") === WHISPER_MODEL.sha1;
    } catch {
      this.verifiedModel = false;
    }
    return this.verifiedModel;
  }
  async execute(
    input: DesktopDictationInput,
    owner: number,
    configuredExecutable: string,
  ): Promise<DesktopDictationResult> {
    if (input.action === "cancel") return this.run(input, owner, configuredExecutable);
    if (this.active)
      return input.action === "status"
        ? this.state
        : {
            ...this.state,
            state: "unavailable",
            message: "Another local dictation operation is still finishing. Try again shortly.",
          };
    if (input.action === "status") return this.run(input, owner, configuredExecutable);
    const finished = Promise.withResolvers<void>();
    const operation = {
      owner,
      id: input.operationId ?? "",
      abort: new AbortController(),
      done: finished.promise,
    };
    this.active = operation;
    this.state = {
      ...this.state,
      state: input.action === "install" ? "downloading" : "transcribing",
      message: "Preparing local dictation…",
    };
    try {
      return await this.run(input, owner, configuredExecutable);
    } catch {
      this.state = {
        ...this.state,
        state: "failed",
        message: "Could not access local dictation files. Check desktop permissions and retry.",
      };
      return this.state;
    } finally {
      if (this.active === operation) this.active = null;
      finished.resolve();
    }
  }
  private async run(
    input: DesktopDictationInput,
    owner: number,
    configuredExecutable: string,
  ): Promise<DesktopDictationResult> {
    if (input.action === "cancel") {
      if (
        this.active?.owner === owner &&
        (!input.operationId || this.active.id === input.operationId)
      )
        this.active.abort.abort();
      return {
        ...this.state,
        state: "cancelled",
        message: "Dictation cancelled. Your draft is unchanged.",
      };
    }
    if (!["darwin", "linux", "win32"].includes(this.platform))
      return {
        ...this.state,
        state: "unavailable",
        message: "Local dictation is not supported on this desktop platform.",
      };
    await NodeFSP.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (input.action === "remove") {
      await NodeFSP.rm(NodePath.join(this.directory, WHISPER_MODEL.file), { force: true });
      this.verifiedModel = false;
      this.state = {
        ...this.state,
        state: "missing-model",
        message: "Local model removed.",
        downloadedBytes: 0,
        totalBytes: 0,
      };
      return this.state;
    }
    const executable = await this.executable(configuredExecutable);
    if (input.action === "status") {
      if (!executable)
        return {
          ...this.state,
          state: "unavailable",
          message:
            "Install whisper.cpp (macOS: brew install whisper-cpp), then select its whisper-cli executable. Windows and Linux require a compatible local whisper-cli build.",
        };
      const ready = await this.verify();
      return {
        ...this.state,
        state: ready ? "ready" : "missing-model",
        message: ready
          ? "Local model ready. Audio stays on this computer."
          : "Download the 75 MiB multilingual model to enable offline transcription.",
      };
    }
    if (input.action === "transcribe" && (!executable || !(await this.verify())))
      return {
        ...this.state,
        state: "unavailable",
        message: "A working whisper-cli and verified local model are required.",
      };
    const operation = this.active!;
    const signal = operation.abort.signal;
    let temporaryDirectory: string | null = null;
    try {
      if (input.action === "install") {
        this.state = {
          state: "downloading",
          message: "Downloading the local model from Hugging Face…",
          downloadedBytes: 0,
          totalBytes: 0,
        };
        temporaryDirectory = await NodeFSP.mkdtemp(NodePath.join(this.directory, "download-"));
        const temporaryFile = NodePath.join(temporaryDirectory, "model.part");
        const response = await this.fetchModel(WHISPER_MODEL.url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]),
        });
        if (!response.ok || !response.body)
          throw new Error("Model download failed. Check the connection and try again.");
        const length = Number(response.headers.get("content-length"));
        if (length > WHISPER_MODEL.maxBytes)
          throw new Error("The model download exceeded its size limit.");
        this.state = { ...this.state, totalBytes: Number.isFinite(length) ? length : 0 };
        const file = await NodeFSP.open(temporaryFile, "wx", 0o600);
        const hash = NodeCrypto.createHash("sha1");
        try {
          for await (const chunk of response.body) {
            if (signal.aborted) throw new Error("Cancelled");
            const count = this.state.downloadedBytes + chunk.length;
            if (count > WHISPER_MODEL.maxBytes)
              throw new Error("The model download exceeded its size limit.");
            hash.update(chunk);
            await file.writeFile(chunk);
            this.state = { ...this.state, downloadedBytes: count };
          }
        } finally {
          await file.close();
        }
        if (hash.digest("hex") !== WHISPER_MODEL.sha1)
          throw new Error(
            "Model checksum did not match upstream. The download was discarded; retry installation.",
          );
        if (signal.aborted) throw new Error("Cancelled");
        await NodeFSP.rename(temporaryFile, NodePath.join(this.directory, WHISPER_MODEL.file));
        this.verifiedModel = true;
        this.state = {
          ...this.state,
          state: executable ? "ready" : "unavailable",
          message: executable
            ? "Local model installed and verified."
            : "Model installed. Install whisper-cli to transcribe.",
        };
      } else if (input.action === "transcribe") {
        if (!input.audio) throw new Error("No microphone recording was supplied.");
        validateDictationWav(input.audio);
        this.state = { ...this.state, state: "transcribing", message: "Transcribing locally…" };
        temporaryDirectory = await NodeFSP.mkdtemp(NodePath.join(this.directory, "recording-"));
        const audioPath = NodePath.join(temporaryDirectory, "audio.wav");
        const outputPath = NodePath.join(temporaryDirectory, "transcript");
        await NodeFSP.writeFile(audioPath, input.audio, { mode: 0o600 });
        await runWhisperProcess(
          executable!,
          [
            "-m",
            NodePath.join(this.directory, WHISPER_MODEL.file),
            "-f",
            audioPath,
            "-otxt",
            "-of",
            outputPath,
            "-l",
            "auto",
            "-nt",
            "-ng",
          ],
          signal,
          5 * 60 * 1000,
        );
        const info = await NodeFSP.stat(`${outputPath}.txt`);
        if (info.size > 128_000) throw new Error("The transcript was too large.");
        const transcript = (await NodeFSP.readFile(`${outputPath}.txt`, "utf8")).trim();
        if (signal.aborted) throw new Error("Cancelled");
        this.state = { ...this.state, state: "completed", message: "Transcription completed." };
        return { ...this.state, transcript };
      }
    } catch (error) {
      this.state = {
        ...this.state,
        state: signal.aborted ? "cancelled" : "failed",
        message: signal.aborted
          ? "Cancelled. Your draft is unchanged."
          : error instanceof Error
            ? error.message
            : "Local dictation failed.",
      };
    } finally {
      if (temporaryDirectory)
        await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
    return this.state;
  }
}
