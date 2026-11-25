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
const vitestRunArgs = ["test", "run", "--reporter=verbose", "--testTimeout=30000"];
const serverProject = "t3";
const defaultServerShards = 4;

interface TestProcess {
  readonly name: string;
  readonly args: ReadonlyArray<string>;
}

export function fullProcessPlan(
  projects: ReadonlyArray<string>,
  filterArgs: ReadonlyArray<string>,
  availableCores = defaultServerShards,
): ReadonlyArray<TestProcess> {
  if (!projects.includes(serverProject)) {
    throw new Error(`Vitest did not report the ${serverProject} server project.`);
  }
  const shardCount = Math.min(defaultServerShards, availableCores);
  const otherProjects = projects.filter((project) => project !== serverProject);
  const workers = Math.max(otherProjects.length, availableCores - shardCount);
  return [
    ...Array.from({ length: shardCount }, (_, index) => ({
      name: `${serverProject} shard ${index + 1}/${shardCount}`,
      args: [
        `--project=${serverProject}`,
        `--shard=${index + 1}/${shardCount}`,
        "--no-cache",
        ...filterArgs,
      ],
    })),
    ...otherProjects.map((project, index) => ({
      name: project,
      args: [
        `--project=${project}`,
        `--maxWorkers=${Math.floor(workers / otherProjects.length) + Number(index < workers % otherProjects.length)}`,
        ...filterArgs,
      ],
    })),
  ];
}

export function aggregateExitCode(codes: ReadonlyArray<number>): number {
  return codes.find((code) => code !== 0) ?? 0;
}

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
  name = "test run",
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
      if (Date.now() - lastOutput < IDLE_LIMIT_MS || child.pid === undefined) return;
      clearInterval(watchdog);
      console.error(
        `fork-tests: ${name}: no output for ${IDLE_LIMIT_MS / 1000}s; stopping the run.`,
      );
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }, 1000);
    child.on("close", (code) => {
      clearInterval(watchdog);
      resolve(code ?? 1);
    });
  });
}

function runVitest(args: ReadonlyArray<string>): Promise<number> {
  return runTests(vitePlus, [...vitestRunArgs, ...args], {
    ...process.env,
    T3CODE_RENDER_REPORT_DIR: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-renders-")),
  });
}

async function discoverProjects(): Promise<ReadonlyArray<string>> {
  using directory = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "t3-"));
  const listing = NodePath.join(directory.path, "projects.json");
  const code = await runTests(
    vitePlus,
    ["test", "list", "--filesOnly", `--json=${listing}`],
    { ...process.env, T3CODE_RENDER_REPORT_DIR: directory.path },
    "Vitest project discovery",
  );
  if (code !== 0) throw new Error(`Vitest project discovery exited with code ${code}.`);
  const files: unknown = JSON.parse(NodeFS.readFileSync(listing, "utf8"));
  if (!Array.isArray(files)) throw new Error("Expected a Vitest test file listing.");
  const counts = new Map<string, number>();
  for (const file of files) {
    const name: unknown = file?.projectName;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Vitest listed a test file without a project name.");
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts)
    .sort(([a, aCount], [b, bCount]) => bCount - aCount || a.localeCompare(b))
    .map(([name]) => name);
}

async function runFullSuite(filterArgs: ReadonlyArray<string>): Promise<number> {
  const started = performance.now();
  const plan = fullProcessPlan(await discoverProjects(), filterArgs, NodeOS.availableParallelism());
  const reports = await Promise.all(
    [{ name: "Node.js workflow tests", args: ["--test", nodeTestFiles] }, ...plan].map(
      async ({ name, args }, index) => {
        const processStarted = performance.now();
        let code: number;
        try {
          if (index === 0) {
            code = await runTests(process.execPath, args, process.env, name);
          } else {
            using directory = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "t3-"));
            code = await runTests(
              vitePlus,
              [...vitestRunArgs, ...args],
              {
                ...process.env,
                TMPDIR: directory.path,
                TMP: directory.path,
                TEMP: directory.path,
                T3CODE_RENDER_REPORT_DIR: directory.path,
              },
              name,
            );
          }
        } catch (error) {
          console.error(`fork-tests: ${name}:`, error);
          code = 1;
        }
        return { name, code, seconds: (performance.now() - processStarted) / 1000 };
      },
    ),
  );
  for (const { name, code, seconds } of reports) {
    console.log(`fork-tests: ${name}: exit ${code}, ${seconds.toFixed(1)}s`);
  }
  console.log(`fork-tests: total wall time: ${((performance.now() - started) / 1000).toFixed(1)}s`);
  return aggregateExitCode(reports.map(({ code }) => code));
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
  const filterArgs = failures.length === 0 ? [] : ["-t", skipPattern(failures)];
  return argv.length === 0 ? runFullSuite(filterArgs) : runVitest([...argv, ...filterArgs]);
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
