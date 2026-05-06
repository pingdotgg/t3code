import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseEnvironmentTiers } from "../project-md-schema";
import type { Check, CheckContext } from "../registry";
import type { CheckResult, CheckStatus } from "../result";
import { runCli, type RunCliOptions, type RunCliResult } from "../run-cli";

export type PreflightDeps = {
  env: Record<string, string | undefined>;
  readText: (path: string) => string | undefined;
  run: (options: RunCliOptions) => Promise<RunCliResult>;
};

export const defaultDeps: PreflightDeps = {
  env: process.env,
  readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
  run: runCli,
};

export const checkResult = (
  id: string,
  name: string,
  status: CheckStatus,
  startedAt: number,
  options: {
    hint?: string | undefined;
    fixable?: boolean;
    evidence?: CheckResult["evidence"];
  } = {},
): CheckResult => ({
  id,
  name,
  status,
  durationMs: Date.now() - startedAt,
  ...(options.hint === undefined ? {} : { hint: options.hint }),
  fixable: options.fixable ?? false,
  evidence: options.evidence ?? {},
});

export const ok = (cli: RunCliResult): boolean => cli.exitCode === 0 && !cli.timedOut;
export const output = (cli: RunCliResult): string => `${cli.stdout}\n${cli.stderr}`.trim();

export const readProject = (context: CheckContext, deps: PreflightDeps): string =>
  deps.readText(join(context.cwd, "docs", "project.md")) ?? "";

export const readStack = (context: CheckContext, deps: PreflightDeps): "A" | "B" | "unset" => {
  const project = readProject(context, deps);
  if (/\*\*Stack\*\*:\s*\[x\]\s*A/i.test(project)) {
    return "A";
  }

  if (/\*\*Stack\*\*:.+\[x\]\s*B/i.test(project)) {
    return "B";
  }

  return "unset";
};

export const readTierNames = (context: CheckContext, deps: PreflightDeps): string[] => {
  const parsed = parseEnvironmentTiers(readProject(context, deps));
  if (!parsed.ok) {
    return ["dev", "stg", "prod"];
  }

  return parsed.tiers === 2 ? ["dev", "prod"] : ["dev", "stg", "prod"];
};

export const stackCheck = (
  stack: "A" | "B",
  id: string,
  name: string,
  deps: PreflightDeps,
  run: (context: CheckContext, startedAt: number) => Promise<CheckResult>,
): Check => ({
  id,
  name,
  run: async (context) => {
    const startedAt = Date.now();
    const selected = readStack(context, deps);
    if (selected === "unset") {
      return checkResult(id, name, "error", startedAt, {
        hint: "Select Stack A or Stack B in docs/project.md.",
      });
    }

    if (selected !== stack) {
      return checkResult(id, name, "skip", startedAt, { hint: `Project is Stack ${selected}.` });
    }

    return run(context, startedAt);
  },
});

export const runDopplerSecret = (
  context: CheckContext,
  deps: PreflightDeps,
  key: string,
): Promise<RunCliResult> =>
  deps.run({
    cmd: "doppler",
    args: ["secrets", "get", key, "--plain"],
    cwd: context.cwd,
    timeoutMs: context.timeoutMs,
  });
