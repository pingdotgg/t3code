// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Plain async boundary that shells out to the edge-tts CLI and owns its own deadline.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Read aloud with Microsoft Edge's natural voices through the edge-tts CLI
 * (https://github.com/rany2/edge-tts). Electron's own speechSynthesis only
 * sees the basic offline Windows voices, and the Edge read-aloud service
 * needs a token that edge-tts keeps up to date, so the app shells out to it.
 */

export interface EdgeTtsVoice {
  readonly shortName: string;
  readonly gender: string;
  readonly personalities: string;
}

export type EdgeTtsResult =
  | { readonly ok: true; readonly audioBase64: string }
  | { readonly ok: false; readonly error: string };

const VOICE_NAME = /^[a-z]{2,3}-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*Neural$/;
const RATE = /^[+-]\d{1,3}%$/;
const SYNTHESIS_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 30_000;

export function isEdgeTtsVoiceName(value: string): boolean {
  return VOICE_NAME.test(value);
}

export function resolveEdgeTtsCommand(
  env: NodeJS.ProcessEnv = process.env,
  home: string = NodeOS.homedir(),
  exists: (path: string) => boolean = NodeFS.existsSync,
): string {
  const configured = env.T3CODE_EDGE_TTS_PATH?.trim();
  if (configured) return configured;
  // `uv tool install edge-tts` puts it here; the app's PATH may not include it.
  for (const exe of ["edge-tts.exe", "edge-tts"]) {
    const uvToolPath = NodePath.join(home, ".local", "bin", exe);
    if (exists(uvToolPath)) return uvToolPath;
  }
  return "edge-tts";
}

function run(
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(resolveEdgeTtsCommand(), [...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("edge-tts took too long to answer."));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new Error(
          error.code === "ENOENT"
            ? "edge-tts isn't installed. Run: uv tool install edge-tts"
            : error.message,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr });
      else reject(new Error(lastLine(stderr) || `edge-tts exited with code ${code}.`));
    });
  });
}

function lastLine(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  return lines[lines.length - 1]?.trim() ?? "";
}

export async function synthesizeWithEdgeTts(input: {
  readonly text: string;
  readonly voice: string;
  readonly rate?: string;
}): Promise<EdgeTtsResult> {
  const text = input.text.trim();
  if (text.length === 0) return { ok: false, error: "Nothing to read." };
  if (!isEdgeTtsVoiceName(input.voice)) return { ok: false, error: "Unknown voice." };
  const rate = input.rate && RATE.test(input.rate) ? input.rate : "+0%";
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mtcode-read-aloud-"));
  try {
    const textFile = NodePath.join(dir, "text.txt");
    await NodeFSP.writeFile(textFile, text, "utf8");
    const args = ["--voice", input.voice, `--rate=${rate}`, "--file", textFile];
    // The service sometimes answers with no audio; one retry usually works.
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { stdout } = await run(args, SYNTHESIS_TIMEOUT_MS);
        if (stdout.length > 0) return { ok: true, audioBase64: stdout.toString("base64") };
        if (attempt >= 2) return { ok: false, error: "edge-tts returned no audio." };
      } catch (error) {
        if (attempt >= 2 || /isn't installed/.test(String(error))) throw error;
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function parseEdgeTtsVoiceList(output: string): EdgeTtsVoice[] {
  const voices: EdgeTtsVoice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [shortName, gender, , personalities] = line.trim().split(/\s{2,}/);
    if (!shortName || !gender || !isEdgeTtsVoiceName(shortName)) continue;
    voices.push({ shortName, gender, personalities: personalities ?? "" });
  }
  return voices;
}

let cachedVoices: Promise<EdgeTtsVoice[]> | null = null;

export function listEdgeTtsVoices(): Promise<EdgeTtsVoice[]> {
  cachedVoices ??= run(["--list-voices"], LIST_TIMEOUT_MS)
    .then(({ stdout }) => parseEdgeTtsVoiceList(stdout.toString("utf8")))
    .catch(() => {
      cachedVoices = null;
      return [];
    });
  return cachedVoices;
}
