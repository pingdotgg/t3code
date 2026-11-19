// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalRandom:off extendsNativeError:off - Plain-TypeScript game bridge core (sockets, files, vendor HTTP), unit-tested without an Effect runtime; GameDevService wraps it.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Small filesystem and process helpers shared by the Game Development modules. */

export async function exists(path: string): Promise<boolean> {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await NodeFSP.readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function listDir(path: string): Promise<ReadonlyArray<NodeFS.Dirent>> {
  try {
    return await NodeFSP.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await NodeFSP.rename(temporary, path);
}

export async function sha256File(path: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    NodeFS.createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}

export function run(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: String(error) });
      return;
    }
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 4_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 1_000_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Starts a GUI program the user keeps using after Continuum exits. */
export function launchDetached(command: string, args: ReadonlyArray<string>, cwd?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid ?? 0);
    });
  });
}

/** Opens a file or URL with the OS default handler (installers, disk images, vendor links). */
export function openWithSystem(target: string, platform: string): Promise<number> {
  if (platform === "win32") return launchDetached("cmd.exe", ["/d", "/c", "start", '""', target]);
  if (platform === "darwin") return launchDetached("open", [target]);
  return launchDetached("xdg-open", [target]);
}

export interface DownloadProgress {
  readonly completed: number;
  readonly total: number | null;
  readonly resumed: boolean;
}

/**
 * Downloads to `<destination>.part`, continuing a previous partial download with an HTTP range
 * request when the server allows it, and verifies the checksum before moving it into place.
 */
export async function downloadResumable(input: {
  readonly url: string;
  readonly destination: string;
  readonly sha256: string | null;
  readonly onProgress: (progress: DownloadProgress) => void;
  readonly signal?: AbortSignal;
}): Promise<{ readonly path: string; readonly resumed: boolean }> {
  const part = `${input.destination}.part`;
  await NodeFSP.mkdir(NodePath.dirname(input.destination), { recursive: true });
  if (await exists(input.destination)) {
    if (input.sha256 === null || (await sha256File(input.destination)) === input.sha256) {
      return { path: input.destination, resumed: true };
    }
    await NodeFSP.rm(input.destination, { force: true });
  }
  const already = (await exists(part)) ? (await NodeFSP.stat(part)).size : 0;
  const response = await fetch(input.url, {
    headers: already > 0 ? { range: `bytes=${already}-` } : {},
    redirect: "follow",
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok || response.body === null) throw new Error(`Download failed with HTTP ${response.status}.`);
  const resumed = already > 0 && response.status === 206;
  const length = Number(response.headers.get("content-length"));
  const total = Number.isFinite(length) && length > 0 ? length + (resumed ? already : 0) : null;
  const stream = NodeFS.createWriteStream(part, { flags: resumed ? "a" : "w" });
  let completed = resumed ? already : 0;
  let reported = 0;
  input.onProgress({ completed, total, resumed });
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      completed += value.byteLength;
      if (!stream.write(value)) await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
      if (completed - reported > 4_000_000) {
        reported = completed;
        input.onProgress({ completed, total, resumed });
      }
    }
  } finally {
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  }
  input.onProgress({ completed, total, resumed });
  if (input.sha256 !== null) {
    const actual = await sha256File(part);
    if (actual !== input.sha256) {
      await NodeFSP.rm(part, { force: true });
      throw new Error("The download failed its checksum and was deleted. Nothing was installed.");
    }
  }
  await NodeFSP.rename(part, input.destination);
  return { path: input.destination, resumed };
}
