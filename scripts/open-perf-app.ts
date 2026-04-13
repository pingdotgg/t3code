import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const serverBinPath = resolve(repoRoot, "apps/server/dist/bin.mjs");
const serverClientIndexPath = resolve(repoRoot, "apps/server/dist/client/index.html");
const PERF_PROVIDER_ENV = "T3CODE_PERF_PROVIDER";
const PERF_SCENARIO_ENV = "T3CODE_PERF_SCENARIO";
const PERF_SEED_JSON_START = "__T3_PERF_SEED_JSON_START__";
const PERF_SEED_JSON_END = "__T3_PERF_SEED_JSON_END__";

type PerfSeedScenarioId = "large_threads" | "burst_base";
type PerfProviderScenarioId = "dense_assistant_stream";

interface PerfSeedThreadSummary {
  readonly id: string;
  readonly projectId: string;
  readonly projectTitle: string | null;
  readonly title: string;
  readonly turnCount: number | null;
  readonly messageCount: number;
  readonly activityCount: number;
  readonly proposedPlanCount: number;
  readonly checkpointCount: number;
}

interface PerfSeedProjectSummary {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly threadCount: number;
}

interface PerfSeededState {
  readonly scenarioId: PerfSeedScenarioId;
  readonly runParentDir: string;
  readonly baseDir: string;
  readonly workspaceRoot: string;
  readonly projectTitle: string | null;
  readonly projectSummaries: ReadonlyArray<PerfSeedProjectSummary>;
  readonly threadSummaries: ReadonlyArray<PerfSeedThreadSummary>;
}

interface CliOptions {
  readonly scenarioId: PerfSeedScenarioId;
  readonly providerScenarioId: PerfProviderScenarioId | null;
  readonly host: string;
  readonly port: number;
  readonly openBrowser: boolean;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: bun run perf:open -- [options]",
      "",
      "Options:",
      "  --scenario <large_threads|burst_base>   Seed scenario to launch (default: large_threads)",
      "  --provider <dense_assistant_stream>      Enable perf provider burst mode",
      "  --host <host>                            Host to bind (default: 127.0.0.1)",
      "  --port <port>                            Port to bind (default: random free port)",
      "  --open                                   Open the URL in your default browser",
      "  --help                                   Show this help",
      "",
      "Examples:",
      "  bun run perf:open -- --scenario large_threads --open",
      "  bun run perf:open -- --scenario burst_base --provider dense_assistant_stream --open",
      "",
      "Notes:",
      "  - This launches the built app, not Vite dev mode.",
      "  - Build artifacts must already exist. Run `bun run test:perf:web` once, or build `@t3tools/web` and `t3` manually.",
      "  - With `--provider dense_assistant_stream`, open the burst thread and send one message to trigger the live multi-thread websocket burst.",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv: ReadonlyArray<string>): CliOptions {
  let scenarioId: PerfSeedScenarioId = "large_threads";
  let providerScenarioId: PerfProviderScenarioId | null = null;
  let host = "127.0.0.1";
  let port = 0;
  let openBrowser = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--scenario": {
        const next = argv[index + 1];
        if (next !== "large_threads" && next !== "burst_base") {
          throw new Error(
            `Expected a valid perf seed scenario after --scenario, received '${next ?? "<missing>"}'.`,
          );
        }
        scenarioId = next;
        index += 1;
        break;
      }
      case "--provider": {
        const next = argv[index + 1];
        if (next !== "dense_assistant_stream") {
          throw new Error(
            `Expected a valid perf provider scenario after --provider, received '${next ?? "<missing>"}'.`,
          );
        }
        providerScenarioId = next;
        index += 1;
        break;
      }
      case "--host": {
        const next = argv[index + 1];
        if (!next) {
          throw new Error("Expected a host value after --host.");
        }
        host = next;
        index += 1;
        break;
      }
      case "--port": {
        const next = argv[index + 1];
        const parsed = next ? Number.parseInt(next, 10) : Number.NaN;
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          throw new Error(`Expected a valid port after --port, received '${next ?? "<missing>"}'.`);
        }
        port = parsed;
        index += 1;
        break;
      }
      case "--open":
        openBrowser = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument '${argument}'. Use --help for usage.`);
    }
  }

  return {
    scenarioId,
    providerScenarioId,
    host,
    port,
    openBrowser,
  };
}

async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to resolve a free localhost port."));
        return;
      }
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function verifyBuiltArtifacts(): Promise<void> {
  await Promise.all([access(serverBinPath), access(serverClientIndexPath)]).catch(() => {
    throw new Error(
      `Built perf artifacts are missing. Expected ${serverBinPath} and ${serverClientIndexPath}. Run bun run test:perf:web or build the app first.`,
    );
  });
}

function parsePerfSeededState(stdout: string): PerfSeededState {
  const startIndex = stdout.lastIndexOf(PERF_SEED_JSON_START);
  const endIndex = stdout.lastIndexOf(PERF_SEED_JSON_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error(`Perf seed command did not emit the expected JSON markers.\n${stdout}`);
  }

  const payload = stdout.slice(startIndex + PERF_SEED_JSON_START.length, endIndex).trim();
  return JSON.parse(payload) as PerfSeededState;
}

async function seedPerfState(scenarioId: PerfSeedScenarioId): Promise<PerfSeededState> {
  const seedProcess = spawn("bun", ["run", "apps/server/scripts/seedPerfState.ts", scenarioId], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  seedProcess.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  seedProcess.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const [exitCode] = (await once(seedProcess, "exit")) as [number | null];
  if (exitCode !== 0) {
    throw new Error(`Perf seed command failed with code ${exitCode ?? "unknown"}.\n${stderr}`);
  }

  return parsePerfSeededState(stdout);
}

async function waitForServerReady(url: string, process: ChildProcess): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = 45_000;
  const requestTimeoutMs = 1_000;

  while (Date.now() - startedAt < timeoutMs) {
    if (process.exitCode !== null) {
      throw new Error(`Perf server exited early with code ${process.exitCode}.`);
    }
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore connection races during startup.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }

  throw new Error(`Timed out waiting for perf server readiness at ${url}.`);
}

async function stopChildProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) {
    return;
  }

  process.kill("SIGTERM");
  const exited = await new Promise<boolean>((resolveExited) => {
    const timer = setTimeout(() => resolveExited(false), 5_000);
    process.once("exit", () => {
      clearTimeout(timer);
      resolveExited(true);
    });
  });

  if (!exited && process.exitCode === null) {
    process.kill("SIGKILL");
    await new Promise<void>((resolveExited) => {
      process.once("exit", () => resolveExited());
    });
  }
}

async function cleanupPerfRunDir(runParentDir: string): Promise<void> {
  await rm(runParentDir, { recursive: true, force: true });
}

function openUrl(url: string): void {
  const command: [string, ...string[]] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const child = spawn(command[0], command.slice(1), {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function printSeedSummary(
  seededState: PerfSeededState,
  url: string,
  providerScenarioId: string | null,
): void {
  process.stdout.write(`\nPerf app ready at ${url}\n`);
  process.stdout.write(`Scenario: ${seededState.scenarioId}\n`);
  process.stdout.write(`Base dir: ${seededState.baseDir}\n`);
  process.stdout.write(`Primary workspace: ${seededState.workspaceRoot}\n`);
  process.stdout.write("Projects:\n");
  for (const project of seededState.projectSummaries) {
    process.stdout.write(
      `  - ${project.title} (${project.id}): ${project.threadCount} threads, ${project.workspaceRoot}\n`,
    );
  }

  process.stdout.write("Threads:\n");
  for (const thread of seededState.threadSummaries.toSorted(
    (left, right) =>
      right.messageCount - left.messageCount || left.title.localeCompare(right.title),
  )) {
    process.stdout.write(
      `  - ${thread.projectTitle ?? "<unknown project>"} / ${thread.title} (${thread.id}): ${thread.turnCount ?? "?"} turns, ${thread.messageCount} messages, ${thread.activityCount} worklog rows, ${thread.proposedPlanCount} plans, ${thread.checkpointCount} checkpoints\n`,
    );
  }

  if (providerScenarioId !== null) {
    process.stdout.write("\nLive burst mode is enabled.\n");
    process.stdout.write(
      "Open the burst thread and send one message to trigger the multi-thread websocket burst.\n",
    );
  }

  process.stdout.write("\nPress Ctrl+C to stop the server.\n\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await verifyBuiltArtifacts();
  const seededState = await seedPerfState(options.scenarioId);
  const port = options.port === 0 ? await pickFreePort() : options.port;

  const serverProcess = spawn(
    "node",
    [
      serverBinPath,
      "--mode",
      "web",
      "--host",
      options.host,
      "--port",
      port.toString(),
      "--base-dir",
      seededState.baseDir,
      "--no-browser",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...(options.providerScenarioId
          ? {
              [PERF_PROVIDER_ENV]: "1",
              [PERF_SCENARIO_ENV]: options.providerScenarioId,
            }
          : {}),
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdout.write(`\nReceived ${signal}. Stopping perf app...\n`);
    await stopChildProcess(serverProcess);
    await cleanupPerfRunDir(seededState.runParentDir);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    const url = `http://${options.host}:${port.toString()}`;
    await waitForServerReady(url, serverProcess);
    printSeedSummary(seededState, url, options.providerScenarioId);

    if (options.openBrowser) {
      openUrl(url);
    }

    const [exitCode] = (await once(serverProcess, "exit")) as [number | null];
    if (!shuttingDown) {
      await cleanupPerfRunDir(seededState.runParentDir);
      process.exit(exitCode ?? 0);
    }
  } catch (error) {
    await stopChildProcess(serverProcess);
    await cleanupPerfRunDir(seededState.runParentDir);
    throw error;
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
