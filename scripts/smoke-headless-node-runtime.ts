#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalTimers:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const ChildProcess = NodeChildProcess;
const FileSystem = NodeFS;
const Net = NodeNet;
const OS = NodeOS;
const Path = NodePath;

export const HEADLESS_READY_LINE = "T3 Code server is ready.";
const STARTUP_TIMEOUT_MS = 30_000;
const TERMINATION_TIMEOUT_MS = 5_000;

export interface HeadlessRuntimeSmokeCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

export function buildHeadlessRuntimeSmokeCommand(input: {
  readonly nodePath: string;
  readonly serverPath: string;
  readonly homeDir: string;
  readonly port: number;
}): HeadlessRuntimeSmokeCommand {
  return {
    executable: input.nodePath,
    args: [
      input.serverPath,
      "serve",
      "--base-dir",
      input.homeDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port),
    ],
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function validateHeadlessEnvironmentDescriptor(descriptor: unknown): void {
  if (!isRecord(descriptor) || !isRecord(descriptor.capabilities)) {
    throw new Error("Headless runtime returned an invalid environment descriptor.");
  }

  const node = descriptor.capabilities.jarvisNode;
  if (!isRecord(node)) {
    throw new Error("Headless runtime descriptor is missing Jarvis node capabilities.");
  }

  const expected: Record<string, unknown> = {
    preset: "headless",
    ui: false,
    parakeet: false,
    kokoro: false,
    pocket: false,
    execution: true,
    projects: true,
    providers: true,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (node[name] !== value) {
      throw new Error(
        `Headless runtime capability '${name}' was ${JSON.stringify(node[name])}, expected ${JSON.stringify(value)}.`,
      );
    }
  }
}

const waitForClose = (child: NodeChildProcess.ChildProcess, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(
      () => reject(new Error(`Child process did not exit within ${timeoutMs}ms.`)),
      timeoutMs,
    );
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

const waitForStartup = (child: NodeChildProcess.ChildProcess, timeoutMs: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      reject(new Error("Headless runtime child was not created with piped output."));
      return;
    }
    let output = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes(HEADLESS_READY_LINE)) {
        finish(() => resolve(output));
      }
    };
    const onError = (error: Error) => {
      finish(() =>
        reject(new Error(`Headless runtime failed to start: ${error.message}\n${output}`)),
      );
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() =>
        reject(
          new Error(
            `Headless runtime exited before readiness (code ${code ?? "none"}, signal ${signal ?? "none"}).\n${output}`,
          ),
        ),
      );
    };
    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(new Error(`Timed out waiting for '${HEADLESS_READY_LINE}'.\n${output}`)),
        ),
      timeoutMs,
    );
    stdout.on("data", onData);
    stderr.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });

const reservePort = async (): Promise<number> => {
  const server = Net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve an ephemeral TCP port for the headless smoke.");
  }
  return address.port;
};

const findPackagedServer = async (
  rootDir: string,
): Promise<{ nodePath: string; serverPath: string }> => {
  const nodePath = Path.join(rootDir, "node", "bin", "node");
  const versionsDir = Path.join(rootDir, "runtime", "versions");
  const versions = await FileSystem.readdir(versionsDir, { withFileTypes: true });
  const candidates: string[] = [];
  for (const version of versions) {
    if (!version.isDirectory()) continue;
    const candidate = Path.join(versionsDir, version.name, "node_modules", "t3", "dist", "bin.mjs");
    try {
      if ((await FileSystem.stat(candidate)).isFile()) candidates.push(candidate);
    } catch {
      // Ignore unrelated runtime-version entries; the archive audit handles missing payloads.
    }
  }
  const [serverPath] = candidates;
  if (serverPath === undefined || candidates.length !== 1) {
    throw new Error(
      `Expected exactly one packaged T3 server entrypoint, found ${candidates.length}.`,
    );
  }
  return { nodePath, serverPath };
};

const terminateExactChild = async (child: NodeChildProcess.ChildProcess): Promise<void> => {
  if (child.pid === undefined || child.pid === null) {
    throw new Error("Headless runtime child did not expose a PID.");
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForClose(child, TERMINATION_TIMEOUT_MS);
  } catch {
    // The fallback still targets only the PID owned by this ChildProcess handle.
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForClose(child, TERMINATION_TIMEOUT_MS);
  }
};

export async function runHeadlessRuntimeSmoke(rootDir: string): Promise<void> {
  const absoluteRoot = Path.resolve(rootDir);
  const { nodePath, serverPath } = await findPackagedServer(absoluteRoot);
  const homeDir = await FileSystem.mkdtemp(
    Path.join(OS.tmpdir(), "jarvis-headless-runtime-smoke-"),
  );
  let child: NodeChildProcess.ChildProcess | undefined;
  try {
    await FileSystem.mkdir(Path.join(homeDir, "config"), { recursive: true });
    await FileSystem.copyFile(
      Path.join(absoluteRoot, "config", "node-preset.json"),
      Path.join(homeDir, "config", "node-preset.json"),
    );
    const port = await reservePort();
    const command = buildHeadlessRuntimeSmokeCommand({ nodePath, serverPath, homeDir, port });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      T3CODE_HOME: homeDir,
      JARVIS_HEADLESS_HOME: homeDir,
    };
    delete env.JARVIS_NODE_PRESET;
    delete env.T3CODE_PORT;
    delete env.T3CODE_HOST;
    delete env.T3CODE_MODE;
    delete env.VITE_DEV_SERVER_URL;
    const spawnedChild = ChildProcess.spawn(command.executable, [...command.args], {
      cwd: absoluteRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawnedChild;
    await waitForStartup(spawnedChild, STARTUP_TIMEOUT_MS);
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`);
    if (!response.ok) {
      throw new Error(`Headless environment descriptor returned HTTP ${response.status}.`);
    }
    validateHeadlessEnvironmentDescriptor(await response.json());
  } finally {
    if (child !== undefined) await terminateExactChild(child);
    await FileSystem.rm(homeDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const rootDir = process.argv[2];
  if (rootDir === undefined) {
    console.error("Usage: smoke-headless-node-runtime.ts <extracted-artifact-root>");
    process.exitCode = 2;
  } else {
    runHeadlessRuntimeSmoke(rootDir).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
