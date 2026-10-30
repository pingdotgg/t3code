// @effect-diagnostics nodeBuiltinImport:off - This adapter owns the native helper's process and temporary audio lifecycle.
// @effect-diagnostics globalTimers:off - Helper deadlines must also bound a stalled native process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import { DesktopVoiceTranscript } from "@t3tools/contracts";

const HelperMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("recording"), locale: Schema.String }),
  Schema.Struct({ type: Schema.Literal("transcript"), ...DesktopVoiceTranscript.fields }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(HelperMessage));
const probe = NodeUtil.promisify(NodeChildProcess.execFile);

type Session = {
  readonly owner: number;
  readonly id: string;
  readonly onRecording: () => void;
  recording: boolean;
  readonly result: ReturnType<typeof Promise.withResolvers<DesktopVoiceTranscript>>;
  readonly done: ReturnType<typeof Promise.withResolvers<void>>;
  child: NodeChildProcess.ChildProcessWithoutNullStreams | null;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

export class DesktopVoiceSession {
  private active: Session | null = null;

  private readonly helperPath: string | null;

  constructor(helperPath: string | null) {
    this.helperPath = helperPath;
  }

  async available(): Promise<boolean> {
    if (!this.helperPath) return false;
    try {
      const { stdout } = await probe(this.helperPath, ["--probe"], {
        timeout: 10_000,
        maxBuffer: 4096,
      });
      const value: unknown = JSON.parse(stdout);
      return (
        typeof value === "object" && value !== null && "type" in value && value.type === "available"
      );
    } catch {
      return false;
    }
  }

  async start(owner: number, id: string, onRecording: () => void): Promise<DesktopVoiceTranscript> {
    if (!this.helperPath)
      return Promise.reject(new Error("Voice input is unavailable on this platform."));
    if (this.active) return Promise.reject(new Error("Another voice recording is already active."));
    const session: Session = {
      owner,
      id,
      onRecording,
      recording: false,
      result: Promise.withResolvers(),
      done: Promise.withResolvers(),
      child: null,
      cancelled: false,
      timer: null,
    };
    this.active = session;
    // Stop may never be called when preparation fails or the renderer closes.
    void session.result.promise.catch(() => {});
    void this.run(session, this.helperPath);
    try {
      return await session.result.promise;
    } finally {
      await session.done.promise;
    }
  }

  stop(owner: number, id: string): void {
    const session = this.owned(owner, id);
    if (!session || session.cancelled || !session.recording)
      throw new Error("This voice recording is no longer active.");
    this.deadline(session, 60_000);
    session.child?.stdin.write("stop\n");
  }

  async cancel(owner: number, id?: string): Promise<void> {
    const session = this.active;
    if (!session || session.owner !== owner || (id !== undefined && session.id !== id)) return;
    session.cancelled = true;
    session.child?.kill("SIGKILL");
    await session.done.promise;
  }

  async dispose(): Promise<void> {
    if (this.active) await this.cancel(this.active.owner);
  }

  private owned(owner: number, id: string): Session | null {
    return this.active?.owner === owner && this.active.id === id ? this.active : null;
  }

  private deadline(session: Session, milliseconds: number): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => session.child?.kill("SIGKILL"), milliseconds);
    session.timer.unref();
  }

  private async run(session: Session, helperPath: string): Promise<void> {
    let directory: string | null = null;
    try {
      directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-voice-"));
      if (session.cancelled) throw new Error("Voice input was cancelled.");
      const child = NodeChildProcess.spawn(helperPath, ["--record", directory], { stdio: "pipe" });
      session.child = child;
      this.deadline(session, 12 * 60_000);
      let pending = "";
      let transcript: DesktopVoiceTranscript | null = null;
      let failure: Error | null = null;
      child.stdin.on("error", () => {});
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        pending += chunk;
        try {
          if (pending.length > 256_000)
            throw new Error("Voice helper response exceeded its limit.");
          let newline: number;
          while ((newline = pending.indexOf("\n")) !== -1) {
            const message = decodeMessage(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            if (message.type === "recording") {
              session.recording = true;
              session.onRecording();
            } else if (message.type === "transcript")
              transcript = { text: message.text, locale: message.locale };
            else throw new Error(message.message);
          }
        } catch (error) {
          failure = error instanceof Error ? error : new Error("Invalid voice helper response.");
          child.kill("SIGKILL");
        }
      });
      // Native diagnostics can contain audio metadata; only structured errors reach the renderer.
      child.stderr.resume();
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (session.cancelled) throw new Error("Voice input was cancelled.");
      if (failure) throw failure;
      if (code !== 0 || !transcript)
        throw new Error("Voice input stopped before transcription finished.");
      session.result.resolve(transcript);
    } catch (error) {
      session.result.reject(error);
    } finally {
      if (session.timer) clearTimeout(session.timer);
      if (directory) await NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => {});
      if (this.active === session) this.active = null;
      session.done.resolve();
    }
  }
}
