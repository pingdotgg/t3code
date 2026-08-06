import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";

import type { DesktopLocalRebuildResult, DesktopLocalRebuildState } from "@t3tools/contracts";

const INSTALL_SCRIPT_RELATIVE_PATH = Path.join("scripts", "install-t3-dev.sh");

export function readEmbeddedDevSourceRoot(appRoot: string): string | null {
  try {
    const raw = FS.readFileSync(Path.join(appRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { t3codeDevSourceRoot?: unknown };
    return typeof parsed.t3codeDevSourceRoot === "string"
      ? parsed.t3codeDevSourceRoot.trim() || null
      : null;
  } catch {
    return null;
  }
}

export function resolveLocalDevRebuildState(input: {
  readonly isPackaged: boolean;
  readonly isDevAppFlavor: boolean;
  readonly platform: NodeJS.Platform;
  readonly sourceRoot: string | null;
}): DesktopLocalRebuildState {
  const unavailable = (reason: string): DesktopLocalRebuildState => ({
    enabled: false,
    sourceRoot: null,
    reason,
  });

  if (!input.isPackaged || !input.isDevAppFlavor) {
    return unavailable("Local rebuilds are only available in packaged Dev builds.");
  }
  if (input.platform !== "darwin") {
    return unavailable("Local rebuilds are currently available only on macOS.");
  }
  if (!input.sourceRoot) {
    return unavailable("This Dev build does not identify its source checkout.");
  }

  try {
    const sourceRoot = FS.realpathSync(Path.resolve(input.sourceRoot));
    const packageJsonPath = Path.join(sourceRoot, "package.json");
    const installScriptPath = Path.join(sourceRoot, INSTALL_SCRIPT_RELATIVE_PATH);
    const packageJson = JSON.parse(FS.readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
    };
    if (packageJson.name !== "@t3tools/monorepo" || !FS.statSync(installScriptPath).isFile()) {
      return unavailable("The embedded source checkout is not a valid T3 Code repository.");
    }
    return { enabled: true, sourceRoot, reason: null };
  } catch {
    return unavailable("The embedded source checkout is no longer available.");
  }
}

export function launchLocalDevRebuild(
  state: DesktopLocalRebuildState,
  logDirectory: string,
  spawn: typeof ChildProcess.spawn = ChildProcess.spawn,
  onExit: () => void = () => {},
): Promise<DesktopLocalRebuildResult> {
  if (!state.enabled || !state.sourceRoot) {
    return Promise.resolve({ accepted: false, logPath: null, message: state.reason });
  }

  const logPath = Path.join(logDirectory, "dev-rebuild.log");
  try {
    FS.mkdirSync(logDirectory, { recursive: true });
    FS.writeFileSync(logPath, `[${new Date().toISOString()}] Local rebuild requested.\n`);
    const child = spawn("/bin/bash", [Path.join(state.sourceRoot, INSTALL_SCRIPT_RELATIVE_PATH)], {
      cwd: state.sourceRoot,
      detached: true,
      env: { ...process.env, T3CODE_DEV_REBUILD_LOG_PATH: logPath },
      stdio: "ignore",
    });

    return new Promise((resolve) => {
      let settled = false;
      let exited = false;
      const notifyExit = (): void => {
        if (exited) return;
        exited = true;
        onExit();
      };
      child.once("error", (error) => {
        FS.appendFileSync(logPath, `[desktop] Failed to launch local rebuild: ${error.message}\n`);
        if (!settled) {
          settled = true;
          resolve({ accepted: false, logPath, message: error.message });
        }
        notifyExit();
      });
      child.once("exit", notifyExit);
      child.once("spawn", () => {
        settled = true;
        child.unref();
        resolve({ accepted: true, logPath, message: null });
      });
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve({ accepted: false, logPath, message });
  }
}
