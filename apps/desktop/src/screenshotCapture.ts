import * as ChildProcess from "node:child_process";
import * as FSNative from "node:fs";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { promisify } from "node:util";

import type { DesktopScreenshotCapture } from "@t3tools/contracts";
import { clipboard } from "electron";

const execFile = promisify(ChildProcess.execFile);
const SCREENSHOT_MIME_TYPE = "image/png";
const SCREENSHOT_FILE_BASENAME = "capture.png";
const CANCELLATION_EXIT_CODE = 1;
const TOOL_FAILURE_SEPARATOR = " | ";
const OMARCHY_CAPTURE_RESULT_SETTLE_MS = 125;
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

type ScreenshotFileStat = {
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
};

type OmarchyCaptureArtifactReadResult =
  | { status: "ready"; artifact: DesktopScreenshotCapture }
  | { status: "pending" }
  | { status: "invalid-file"; fileName: string };

const PNG_SIGNATURE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHUNK_OVERHEAD_BYTES = 12;

function nowTimestampSegment(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function screenshotFileName(): string {
  return `screenshot-${nowTimestampSegment()}.png`;
}

function isValidPngImageBytes(imageBytes: Buffer): boolean {
  if (
    imageBytes.byteLength < PNG_SIGNATURE_BYTES.byteLength + PNG_CHUNK_OVERHEAD_BYTES ||
    !imageBytes.subarray(0, PNG_SIGNATURE_BYTES.byteLength).equals(PNG_SIGNATURE_BYTES)
  ) {
    return false;
  }

  let offset = PNG_SIGNATURE_BYTES.byteLength;
  let sawHeaderChunk = false;
  while (offset + PNG_CHUNK_OVERHEAD_BYTES <= imageBytes.byteLength) {
    const chunkLength = imageBytes.readUInt32BE(offset);
    const chunkType = imageBytes.subarray(offset + 4, offset + 8).toString("ascii");
    const nextOffset = offset + PNG_CHUNK_OVERHEAD_BYTES + chunkLength;
    if (nextOffset > imageBytes.byteLength) {
      return false;
    }
    if (!sawHeaderChunk) {
      if (chunkType !== "IHDR") {
        return false;
      }
      sawHeaderChunk = true;
    }
    if (chunkType === "IEND") {
      return true;
    }
    offset = nextOffset;
  }

  return false;
}

function expandUserPath(pathValue: string): string {
  const homeDirectory = OS.homedir();
  return pathValue
    .replace(/^~(?=\/|$)/, homeDirectory)
    .replace(/\$HOME|\$\{HOME\}/g, homeDirectory);
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

function inferHyprlandInstanceSignature(env: NodeJS.ProcessEnv): string | null {
  const runtimeDirectory = env.XDG_RUNTIME_DIR;
  if (!runtimeDirectory) {
    return null;
  }

  const hyprRuntimeDirectory = Path.join(runtimeDirectory, "hypr");
  try {
    const candidates = FSNative.readdirSync(hyprRuntimeDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const socketPath = Path.join(hyprRuntimeDirectory, entry.name, ".socket.sock");
        try {
          const socketStat = FSNative.statSync(socketPath);
          return {
            signature: entry.name,
            mtimeMs: socketStat.mtimeMs,
          };
        } catch {
          return null;
        }
      })
      .filter(
        (candidate): candidate is { signature: string; mtimeMs: number } => candidate !== null,
      )
      .toSorted((left, right) => right.mtimeMs - left.mtimeMs);

    return candidates[0]?.signature ?? null;
  } catch {
    return null;
  }
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

  if (!env.HYPRLAND_INSTANCE_SIGNATURE) {
    const hyprlandInstanceSignature = inferHyprlandInstanceSignature(env);
    if (hyprlandInstanceSignature) {
      env.HYPRLAND_INSTANCE_SIGNATURE = hyprlandInstanceSignature;
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

function tryBuildScreenshotCapture(
  imageBytes: Buffer,
  fileName: string,
): DesktopScreenshotCapture | null {
  if (!isValidPngImageBytes(imageBytes)) {
    return null;
  }

  return {
    name: fileName,
    mimeType: SCREENSHOT_MIME_TYPE,
    sizeBytes: imageBytes.byteLength,
    dataUrl: `data:${SCREENSHOT_MIME_TYPE};base64,${imageBytes.toString("base64")}`,
  };
}

async function resolveOmarchyScreenshotOutputDir(): Promise<string> {
  const envOutputDirectory = process.env.OMARCHY_SCREENSHOT_DIR?.trim();
  if (envOutputDirectory) {
    return Path.resolve(expandUserPath(envOutputDirectory));
  }

  const envPicturesDirectory = process.env.XDG_PICTURES_DIR?.trim();
  if (envPicturesDirectory) {
    return Path.resolve(expandUserPath(envPicturesDirectory));
  }

  try {
    const userDirsFilePath = Path.join(OS.homedir(), ".config", "user-dirs.dirs");
    const userDirsFile = await FS.readFile(userDirsFilePath, "utf8");
    const picturesDirectoryMatch = userDirsFile.match(
      /^XDG_PICTURES_DIR=(?:"([^"]+)"|'([^']+)'|([^\n#]+))/m,
    );
    const configuredDirectory =
      picturesDirectoryMatch?.[1] ?? picturesDirectoryMatch?.[2] ?? picturesDirectoryMatch?.[3];
    if (configuredDirectory) {
      return Path.resolve(expandUserPath(configuredDirectory.trim()));
    }
  } catch {
    // Fall back to the standard Pictures directory when user-dirs lookup fails.
  }

  return Path.join(OS.homedir(), "Pictures");
}

async function listScreenshotFiles(
  directoryPath: string,
): Promise<ReadonlyArray<ScreenshotFileStat>> {
  try {
    const entries = await FS.readdir(directoryPath, { withFileTypes: true });
    const fileStats = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
        .map(async (entry) => {
          const filePath = Path.join(directoryPath, entry.name);
          const stat = await FS.stat(filePath);
          return {
            filePath,
            mtimeMs: stat.mtimeMs,
            sizeBytes: stat.size,
          } satisfies ScreenshotFileStat;
        }),
    );

    fileStats.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return fileStats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function changedScreenshotFile(
  beforeCapture: ReadonlyArray<ScreenshotFileStat>,
  afterCapture: ReadonlyArray<ScreenshotFileStat>,
): string | null {
  const previousByPath = new Map(
    beforeCapture.map((fileStat) => [fileStat.filePath, fileStat] as const),
  );
  const changedFile = afterCapture.find((fileStat) => {
    const previousFileStat = previousByPath.get(fileStat.filePath);
    if (!previousFileStat) {
      return true;
    }
    return (
      previousFileStat.mtimeMs !== fileStat.mtimeMs ||
      previousFileStat.sizeBytes !== fileStat.sizeBytes
    );
  });

  return changedFile?.filePath ?? null;
}

function readClipboardPng(): Buffer | null {
  try {
    const image = clipboard.readImage();
    if (image.isEmpty()) {
      return null;
    }
    const pngBytes = image.toPNG();
    return pngBytes.byteLength > 0 && isValidPngImageBytes(pngBytes) ? pngBytes : null;
  } catch {
    return null;
  }
}

async function readOmarchyCaptureArtifact(
  outputDirectory: string,
  filesBeforeCapture: ReadonlyArray<ScreenshotFileStat>,
  clipboardBeforeCapture: Buffer | null,
): Promise<OmarchyCaptureArtifactReadResult> {
  const filesAfterCapture = await listScreenshotFiles(outputDirectory);
  const outputFilePath = changedScreenshotFile(filesBeforeCapture, filesAfterCapture);
  if (outputFilePath) {
    const imageBytes = await FS.readFile(outputFilePath);
    if (imageBytes.byteLength === 0) {
      return { status: "pending" };
    }

    const artifact = tryBuildScreenshotCapture(
      imageBytes,
      Path.basename(outputFilePath) || screenshotFileName(),
    );
    return artifact
      ? { status: "ready", artifact }
      : {
          status: "invalid-file",
          fileName: Path.basename(outputFilePath) || screenshotFileName(),
        };
  }

  const clipboardAfterCapture = readClipboardPng();
  if (
    clipboardAfterCapture &&
    (clipboardBeforeCapture == null || !clipboardAfterCapture.equals(clipboardBeforeCapture))
  ) {
    return {
      status: "ready",
      artifact: tryBuildScreenshotCapture(clipboardAfterCapture, screenshotFileName())!,
    };
  }

  return { status: "pending" };
}

async function captureWithOmarchy(command: string): Promise<DesktopScreenshotCapture | null> {
  const outputDirectory = await resolveOmarchyScreenshotOutputDir();
  const filesBeforeCapture = await listScreenshotFiles(outputDirectory);
  const clipboardBeforeCapture = readClipboardPng();

  return new Promise((resolve, reject) => {
    const child = ChildProcess.spawn(command, [], {
      env: resolveCaptureCommandEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let checkingArtifact = false;
    let closeResult: Pick<SpawnCaptureResult, "code" | "signal"> | null = null;
    let finalizeTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      directoryWatcher?.close();
      if (clipboardPollInterval !== null) {
        clearInterval(clipboardPollInterval);
      }
      if (finalizeTimer !== null) {
        clearTimeout(finalizeTimer);
      }
    };

    const settleResolve = (result: DesktopScreenshotCapture | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const settleReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const finalizeFromClose = () => {
      if (settled || closeResult === null) {
        return;
      }

      const result: SpawnCaptureResult = {
        code: closeResult.code,
        signal: closeResult.signal,
        stderr,
        stdout,
      };
      if (result.code !== 0) {
        if (result.code === CANCELLATION_EXIT_CODE && cancellationMessage(result.stderr)) {
          settleResolve(null);
          return;
        }
        settleReject(new Error(spawnFailure("omarchy-cmd-screenshot", result)));
        return;
      }

      settleResolve(null);
    };

    const scheduleFinalizeFromClose = () => {
      if (settled || closeResult === null || finalizeTimer !== null) {
        return;
      }

      finalizeTimer = setTimeout(() => {
        finalizeTimer = null;
        void checkForArtifact().finally(() => {
          if (!settled) {
            finalizeFromClose();
          }
        });
      }, OMARCHY_CAPTURE_RESULT_SETTLE_MS);
    };

    const checkForArtifact = async () => {
      if (settled || checkingArtifact) {
        return;
      }

      checkingArtifact = true;
      try {
        const artifactResult = await readOmarchyCaptureArtifact(
          outputDirectory,
          filesBeforeCapture,
          clipboardBeforeCapture,
        );
        if (artifactResult.status === "ready") {
          settleResolve(artifactResult.artifact);
          return;
        }

        if (artifactResult.status === "invalid-file" && closeResult !== null) {
          settleReject(
            new Error(
              `Captured screenshot file '${artifactResult.fileName}' is not a valid PNG image.`,
            ),
          );
          return;
        }

        if (closeResult !== null) {
          scheduleFinalizeFromClose();
        }
      } catch (error) {
        settleReject(error);
      } finally {
        checkingArtifact = false;
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", settleReject);
    child.on("close", (code, signal) => {
      closeResult = { code, signal };
      void checkForArtifact().finally(() => {
        if (!settled) {
          scheduleFinalizeFromClose();
        }
      });
    });

    let directoryWatcher: FSNative.FSWatcher | null = null;
    try {
      directoryWatcher = FSNative.watch(outputDirectory, () => {
        void checkForArtifact();
      });
    } catch {
      directoryWatcher = null;
    }

    const clipboardPollInterval = setInterval(() => {
      void checkForArtifact();
    }, 25);
    void checkForArtifact();
  });
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

    const screenshot = tryBuildScreenshotCapture(imageBytes, screenshotFileName());
    if (!screenshot) {
      throw new Error("Captured screenshot file is not a valid PNG image.");
    }

    return screenshot;
  } finally {
    await FS.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
