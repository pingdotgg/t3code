import * as ChildProcess from "node:child_process";
import * as FSNative from "node:fs";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { promisify } from "node:util";

import type { DesktopScreenshotCapture } from "@t3tools/contracts";

const execFile = promisify(ChildProcess.execFile);
const SCREENSHOT_MIME_TYPE = "image/png";
const SCREENSHOT_FILE_BASENAME = "capture.png";
const CANCELLATION_EXIT_CODE = 1;
const TOOL_FAILURE_SEPARATOR = " | ";
const OMARCHY_SCREENSHOT_COMMAND_PATH = Path.join(
  OS.homedir(),
  ".local",
  "share",
  "omarchy",
  "bin",
  "omarchy-cmd-screenshot",
);

type SpawnCaptureResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
};

function nowTimestampSegment(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function screenshotFileName(): string {
  return `screenshot-${nowTimestampSegment()}.png`;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function errorExitCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === "number" ? maybeCode : null;
}

function errorStderr(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const maybeStderr = (error as { stderr?: unknown }).stderr;
  if (typeof maybeStderr === "string") {
    return maybeStderr.trim();
  }
  return "";
}

function cancellationMessage(stderr: string): boolean {
  if (stderr.length === 0) {
    return true;
  }
  const lower = stderr.toLowerCase();
  return lower.includes("cancel");
}

function looksLikeUserCancel(error: unknown): boolean {
  const exitCode = errorExitCode(error);
  if (exitCode !== CANCELLATION_EXIT_CODE) {
    return false;
  }
  return cancellationMessage(errorStderr(error).trim());
}

function commandFailure(toolName: string, error: unknown): string {
  const stderr = errorStderr(error);
  if (stderr.length > 0) {
    return `${toolName} failed: ${stderr}`;
  }
  return `${toolName} failed: ${normalizeErrorMessage(error)}`;
}

function spawnFailure(toolName: string, result: SpawnCaptureResult): string {
  const stderr = result.stderr.replace(/\s+/g, " ").trim();
  if (stderr.length > 0) {
    return `${toolName} failed: ${stderr}`;
  }
  if (result.signal) {
    return `${toolName} failed: signal ${result.signal}`;
  }
  return `${toolName} failed: exit code ${result.code ?? "unknown"}`;
}

function resolveCaptureCommandEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform !== "linux") {
    return env;
  }

  if (!env.XDG_RUNTIME_DIR && typeof process.getuid === "function") {
    env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  }

  if (!env.WAYLAND_DISPLAY && env.XDG_RUNTIME_DIR) {
    try {
      const socketName = FSNative.readdirSync(env.XDG_RUNTIME_DIR).find((entry) =>
        entry.startsWith("wayland-"),
      );
      if (socketName) {
        env.WAYLAND_DISPLAY = socketName;
      }
    } catch {
      // Keep original environment when runtime dir probing fails.
    }
  }

  return env;
}

function captureEnvSummary(): string {
  const env = resolveCaptureCommandEnv();
  const waylandDisplay = env.WAYLAND_DISPLAY ?? "<unset>";
  const xdgRuntimeDir = env.XDG_RUNTIME_DIR ?? "<unset>";
  const xDisplay = env.DISPLAY ?? "<unset>";
  return `env WAYLAND_DISPLAY=${waylandDisplay} XDG_RUNTIME_DIR=${xdgRuntimeDir} DISPLAY=${xDisplay}`;
}

async function execCaptureCommand(
  fileName: string,
  args: ReadonlyArray<string>,
): Promise<{ stdout: string; stderr: string }> {
  return execFile(fileName, [...args], {
    encoding: "utf8",
    env: resolveCaptureCommandEnv(),
  });
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execCaptureCommand("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function fileIsExecutable(filePath: string): Promise<boolean> {
  try {
    await FS.access(filePath, FSNative.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveOmarchyScreenshotCommand(): Promise<string | null> {
  if (await fileIsExecutable(OMARCHY_SCREENSHOT_COMMAND_PATH)) {
    return OMARCHY_SCREENSHOT_COMMAND_PATH;
  }
  return (await commandExists("omarchy-cmd-screenshot")) ? "omarchy-cmd-screenshot" : null;
}

function runCaptureCommand(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<SpawnCaptureResult> {
  return new Promise((resolve, reject) => {
    const child = ChildProcess.spawn(command, [...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        code,
        signal,
        stderr,
        stdout,
      });
    });
  });
}

function buildScreenshotCapture(
  imageBytes: Buffer,
  fileName: string,
): DesktopScreenshotCapture {
  return {
    name: fileName,
    mimeType: SCREENSHOT_MIME_TYPE,
    sizeBytes: imageBytes.byteLength,
    dataUrl: `data:${SCREENSHOT_MIME_TYPE};base64,${imageBytes.toString("base64")}`,
  };
}

async function readNewestScreenshotFile(directoryPath: string): Promise<string | null> {
  const entries = await FS.readdir(directoryPath, { withFileTypes: true });
  const imageFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
    .map((entry) => Path.join(directoryPath, entry.name));

  if (imageFiles.length === 0) {
    return null;
  }

  const imageFilesWithStats = await Promise.all(
    imageFiles.map(async (filePath) => ({
      filePath,
      stat: await FS.stat(filePath),
    })),
  );
  imageFilesWithStats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  return imageFilesWithStats[0]?.filePath ?? null;
}

async function captureWithOmarchy(command: string): Promise<DesktopScreenshotCapture | null> {
  const tempDir = await FS.mkdtemp(Path.join(OS.tmpdir(), "t3code-screenshot-"));
  try {
    const captureEnv = {
      ...resolveCaptureCommandEnv(),
      OMARCHY_SCREENSHOT_DIR: tempDir,
    };
    const result = await runCaptureCommand(command, ["region"], captureEnv);
    if (result.code !== 0) {
      if (result.code === CANCELLATION_EXIT_CODE && cancellationMessage(result.stderr)) {
        return null;
      }
      throw new Error(spawnFailure("omarchy-cmd-screenshot", result));
    }

    const outputFilePath = await readNewestScreenshotFile(tempDir);
    if (!outputFilePath) {
      return null;
    }

    const imageBytes = await FS.readFile(outputFilePath);
    if (imageBytes.byteLength === 0) {
      throw new Error("Captured Omarchy screenshot file is empty.");
    }

    return buildScreenshotCapture(
      imageBytes,
      Path.basename(outputFilePath) || screenshotFileName(),
    );
  } finally {
    await FS.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function captureWithGrimblast(filePath: string): Promise<"captured" | "cancelled"> {
  try {
    await execCaptureCommand("grimblast", ["--freeze", "--notify", "save", "area", filePath]);
    return "captured";
  } catch (error) {
    if (looksLikeUserCancel(error)) {
      return "cancelled";
    }
    throw new Error(commandFailure("grimblast", error), { cause: error });
  }
}

async function captureWithHyprshot(filePath: string): Promise<"captured" | "cancelled"> {
  try {
    await execCaptureCommand("hyprshot", ["-m", "region", "-f", filePath]);
    return "captured";
  } catch (error) {
    if (looksLikeUserCancel(error)) {
      return "cancelled";
    }
    throw new Error(commandFailure("hyprshot", error), { cause: error });
  }
}

async function captureWithGrimAndSlurpRegion(filePath: string): Promise<"captured" | "cancelled"> {
  let geometry = "";
  try {
    const slurpResult = await execCaptureCommand("slurp", []);
    geometry = slurpResult.stdout.trim();
  } catch (error) {
    if (looksLikeUserCancel(error)) {
      return "cancelled";
    }
    throw new Error(commandFailure("slurp", error), { cause: error });
  }

  if (geometry.length === 0) {
    return "cancelled";
  }

  try {
    await execCaptureCommand("grim", ["-g", geometry, filePath]);
    return "captured";
  } catch (error) {
    throw new Error(commandFailure("grim", error), { cause: error });
  }
}

async function captureWithGrimFullscreen(filePath: string): Promise<void> {
  try {
    await execCaptureCommand("grim", [filePath]);
  } catch (error) {
    throw new Error(commandFailure("grim", error), { cause: error });
  }
}

async function captureWithImportFullscreen(filePath: string): Promise<void> {
  try {
    await execCaptureCommand("import", ["-window", "root", filePath]);
  } catch (error) {
    throw new Error(commandFailure("import", error), { cause: error });
  }
}

async function captureToPath(filePath: string): Promise<"captured" | "cancelled"> {
  const failures: string[] = [];
  const hasGrimblast = await commandExists("grimblast");
  if (hasGrimblast) {
    try {
      return await captureWithGrimblast(filePath);
    } catch (error) {
      failures.push(normalizeErrorMessage(error));
    }
  }

  const hasHyprshot = await commandExists("hyprshot");
  if (hasHyprshot) {
    try {
      return await captureWithHyprshot(filePath);
    } catch (error) {
      failures.push(normalizeErrorMessage(error));
    }
  }

  const [hasGrim, hasSlurp, hasImport] = await Promise.all([
    commandExists("grim"),
    commandExists("slurp"),
    commandExists("import"),
  ]);
  if (hasGrim && hasSlurp) {
    try {
      return await captureWithGrimAndSlurpRegion(filePath);
    } catch (error) {
      failures.push(normalizeErrorMessage(error));
    }
  }

  if (hasGrim) {
    try {
      await captureWithGrimFullscreen(filePath);
      return "captured";
    } catch (error) {
      failures.push(normalizeErrorMessage(error));
    }
  }

  if (hasImport) {
    try {
      await captureWithImportFullscreen(filePath);
      return "captured";
    } catch (error) {
      failures.push(normalizeErrorMessage(error));
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Screenshot capture failed. ${failures.join(TOOL_FAILURE_SEPARATOR)} | ${captureEnvSummary()}`,
    );
  }

  throw new Error(
    `No supported screenshot tool found. Install omarchy-cmd-screenshot, grimblast, hyprshot, grim plus slurp, or import. ${captureEnvSummary()}`,
  );
}

export async function captureDesktopScreenshot(): Promise<DesktopScreenshotCapture | null> {
  if (process.platform !== "linux") {
    throw new Error("Screenshot capture is currently supported on Linux desktop only.");
  }

  const omarchyCommand = await resolveOmarchyScreenshotCommand();
  if (omarchyCommand) {
    return captureWithOmarchy(omarchyCommand);
  }

  const tempDir = await FS.mkdtemp(Path.join(OS.tmpdir(), "t3code-screenshot-"));
  const tempFilePath = Path.join(tempDir, SCREENSHOT_FILE_BASENAME);
  try {
    const captureResult = await captureToPath(tempFilePath);
    if (captureResult === "cancelled") {
      return null;
    }

    const imageBytes = await FS.readFile(tempFilePath);
    if (imageBytes.byteLength === 0) {
      throw new Error("Captured screenshot file is empty.");
    }

    return buildScreenshotCapture(imageBytes, screenshotFileName());
  } finally {
    await FS.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
