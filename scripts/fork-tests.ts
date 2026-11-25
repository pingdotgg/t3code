// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off
// Runs this fork's tests. It skips the upstream tests listed in
// fork-known-failures.json, refuses a Node major other than package.json's
// engines, and stops a run that prints nothing for 30 seconds.
//
//   node scripts/fork-tests.ts [vitest args]   run tests without the known failures
//   node scripts/fork-tests.ts --recheck       run only the known failures, to drop fixed ones
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface KnownFailure {
  readonly file: string;
  readonly test: string;
  readonly reason: string;
}

const root = NodePath.resolve(import.meta.dirname, "..");
const IDLE_LIMIT_MS = 30_000;
const nodeTestFiles = ".github/scripts/*.test.cjs";
const vitePlus = NodePath.join(root, "node_modules/.bin/vp");

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A vitest `-t` pattern that matches every test except the known failures. */
export function skipPattern(failures: ReadonlyArray<KnownFailure>): string {
  return `^(?!.*(?:${failures.map((failure) => escapeRegExp(failure.test)).join("|")})).*$`;
}

export function readKnownFailures(raw: string): ReadonlyArray<KnownFailure> {
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (entry) =>
        typeof entry?.file === "string" &&
        typeof entry?.test === "string" &&
        typeof entry?.reason === "string",
    )
  ) {
    throw new Error("fork-known-failures.json must be an array of { file, test, reason }");
  }
  return parsed;
}

function requireEnginesNode(): void {
  const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8"));
  const wanted = String(manifest.engines.node).split(".")[0];
  const running = process.versions.node.split(".")[0];
  if (wanted !== running) {
    throw new Error(
      `Node ${process.versions.node} is running, but package.json wants ${manifest.engines.node}. Run with: mise exec node@${wanted} -- node scripts/fork-tests.ts`,
    );
  }
}

function runTests(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    child.on("error", reject);
    let lastOutput = Date.now();
    child.stdout.on("data", (chunk) => {
      lastOutput = Date.now();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      lastOutput = Date.now();
      process.stderr.write(chunk);
    });
    const watchdog = setInterval(() => {
      if (Date.now() - lastOutput < IDLE_LIMIT_MS) return;
      console.error(`fork-tests: no output for ${IDLE_LIMIT_MS / 1000}s; stopping the run.`);
      process.kill(-child.pid!, "SIGKILL");
    }, 1000);
    child.on("close", (code) => {
      clearInterval(watchdog);
      resolve(code ?? 1);
    });
  });
}

function runVitest(args: ReadonlyArray<string>): Promise<number> {
  return runTests(
    vitePlus,
    [
      "test",
      "run",
      "--reporter=verbose",
      "--testTimeout=30000",
      "--exclude",
      nodeTestFiles,
      ...args,
    ],
    {
      ...process.env,
      T3CODE_RENDER_REPORT_DIR: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-renders-")),
    },
  );
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  requireEnginesNode();
  const failures = readKnownFailures(
    NodeFS.readFileSync(NodePath.join(root, "scripts/fork-known-failures.json"), "utf8"),
  );
  if (argv[0] === "--recheck") {
    for (const failure of failures) {
      const code = await runVitest([failure.file, "-t", escapeRegExp(failure.test)]);
      console.log(
        code === 0
          ? `fork-tests: passes now, remove it from the list: ${failure.test}`
          : `fork-tests: still fails: ${failure.test}`,
      );
    }
    return 0;
  }
  if (argv.some((arg) => arg === "-t" || arg.startsWith("--testNamePattern"))) {
    throw new Error("fork-tests sets -t itself; run vp test directly to filter by name.");
  }
  if (argv.length === 0) {
    const nodeCode = await runTests(process.execPath, ["--test", nodeTestFiles]);
    if (nodeCode !== 0) return nodeCode;
  }
  return runVitest(failures.length === 0 ? argv : [...argv, "-t", skipPattern(failures)]);
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
