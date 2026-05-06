import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { defaultRegistry, type Check } from "./registry";
import { containsReservedSecretKey } from "./redactor";
import {
  checkResultSchema,
  preflightReportSchema,
  summarizeChecks,
  type CheckResult,
  type PreflightReport,
} from "./result";
import { renderJsonReport } from "./output/json";
import { renderMarkdownReport } from "./output/markdown";
import { renderTerminalReport } from "./output/terminal";
import { applyPreflightFixes } from "./fix/apply";
import { markServiceProvisioned } from "./markdown-services-table";

type RunnerOptions = {
  cwd: string;
  checks: Check[];
  timeoutMs: number;
  only: Set<string>;
  skip: Set<string>;
  writeArtifacts: boolean;
};

type CliOptions = {
  json: boolean;
  fix: boolean;
  write: boolean;
  cacheOnly: boolean;
  timeoutMs: number;
  only: Set<string>;
  skip: Set<string>;
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "..", "..");

const parseList = (value: string | undefined): Set<string> =>
  new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== ""),
  );

const parseCliOptions = (argv: string[]): CliOptions => {
  let json = false;
  let fix = false;
  let write = false;
  let cacheOnly = false;
  let timeoutMs = 5000;
  let only = new Set<string>();
  let skip = new Set<string>();

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--fix") {
      fix = true;
      continue;
    }

    if (arg === "--write") {
      write = true;
      continue;
    }

    if (arg === "--cache-only") {
      cacheOnly = true;
      continue;
    }

    if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = Number.parseInt(arg.slice("--timeout-ms=".length), 10);
      continue;
    }

    if (arg.startsWith("--only=")) {
      only = parseList(arg.slice("--only=".length));
      continue;
    }

    if (arg.startsWith("--skip=")) {
      skip = parseList(arg.slice("--skip=".length));
    }
  }

  return {
    json,
    fix,
    write,
    cacheOnly,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000,
    only,
    skip,
  };
};

const matchesSelector = (id: string, selector: string): boolean => {
  if (selector.endsWith("/*")) {
    return id.startsWith(selector.slice(0, -1));
  }

  return id === selector;
};

const selectedChecks = (checks: Check[], only: Set<string>, skip: Set<string>): Check[] =>
  checks.filter((check) => {
    if (only.size > 0 && ![...only].some((selector) => matchesSelector(check.id, selector))) {
      return false;
    }

    return ![...skip].some((selector) => matchesSelector(check.id, selector));
  });

const normalizeCheckResult = (result: CheckResult): CheckResult => {
  const parsed = checkResultSchema.parse(result);

  if (containsReservedSecretKey(parsed)) {
    return {
      ...parsed,
      status: "error",
      hint: "check leaked secret-shaped field name; fix the check implementation",
      fixable: false,
      evidence: {},
    };
  }

  return parsed;
};

const runCheck = async (check: Check, cwd: string, timeoutMs: number): Promise<CheckResult> => {
  const startedAt = Date.now();

  try {
    return normalizeCheckResult(await check.run({ cwd, timeoutMs }));
  } catch (error) {
    return {
      id: check.id,
      name: check.name,
      status: "error",
      durationMs: Date.now() - startedAt,
      hint: error instanceof Error ? error.message : "check failed with unknown error",
      fixable: false,
      evidence: {},
    };
  }
};

const writeArtifacts = (cwd: string, report: PreflightReport): void => {
  const outputDir = join(cwd, ".local", "preflight");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "latest.json"), `${renderJsonReport(report)}\n`);
  writeFileSync(join(outputDir, "latest.md"), renderMarkdownReport(report));
};

const writeProjectServices = (cwd: string, checks: CheckResult[]): void => {
  const projectPath = join(cwd, "docs", "project.md");
  if (!existsSync(projectPath)) {
    return;
  }

  const serviceChecks = [
    { id: "doppler/cli", service: "Doppler" },
    { id: "stack-a/neon-url", service: "Neon (Stack A)" },
    { id: "stack-b/convex-cli", service: "Convex (Stack B)" },
    { id: "better-auth/url", service: "Better Auth" },
    { id: "sentry/dsn", service: "Sentry" },
    { id: "resend/key", service: "Resend" },
  ];

  const passingServices = serviceChecks
    .filter(({ id }) => checks.some((check) => check.id === id && check.status === "pass"))
    .map(({ service }) => service);

  if (passingServices.length === 0) {
    return;
  }

  const next = passingServices.reduce(
    (markdown, service) => markServiceProvisioned(markdown, service),
    readFileSync(projectPath, "utf8"),
  );
  writeFileSync(projectPath, next);
};

export const runPreflight = async (options: RunnerOptions): Promise<PreflightReport> => {
  const checks = selectedChecks(options.checks, options.only, options.skip);
  const results = await Promise.all(
    checks.map((check) => runCheck(check, options.cwd, options.timeoutMs)),
  );
  const report = preflightReportSchema.parse({
    generatedAt: new Date().toISOString(),
    checks: results,
    summary: summarizeChecks(results),
  });

  if (options.writeArtifacts) {
    writeArtifacts(options.cwd, report);
  }

  return report;
};

const main = async (): Promise<void> => {
  const cli = parseCliOptions(process.argv.slice(2));
  const checks = cli.cacheOnly ? [] : defaultRegistry;
  const baseReport = await runPreflight({
    cwd: repoRoot,
    checks,
    timeoutMs: cli.timeoutMs,
    only: cli.only,
    skip: cli.skip,
    writeArtifacts: false,
  });
  const fixResults = cli.fix
    ? await applyPreflightFixes(
        { cwd: repoRoot, timeoutMs: cli.timeoutMs },
        undefined,
        baseReport.checks,
      )
    : [];
  const report = preflightReportSchema.parse({
    generatedAt: new Date().toISOString(),
    checks: [...baseReport.checks, ...fixResults],
    summary: summarizeChecks([...baseReport.checks, ...fixResults]),
  });

  if (cli.write) {
    writeProjectServices(repoRoot, report.checks);
  }

  writeArtifacts(repoRoot, report);

  process.stdout.write(cli.json ? `${renderJsonReport(report)}\n` : renderTerminalReport(report));
  process.exitCode = report.summary.errors > 0 ? 1 : 0;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown preflight runner failure";
    process.stderr.write(`preflight internal failure: ${message}\n`);
    process.exitCode = 2;
  });
}
