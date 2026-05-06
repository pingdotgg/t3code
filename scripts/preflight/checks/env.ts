import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Check } from "../registry";
import {
  checkResult,
  defaultDeps,
  ok,
  output,
  readStack,
  readTierNames,
  runDopplerSecret,
  stackCheck,
  type PreflightDeps,
} from "./support";
import { createSyncEnvGuardCheck } from "./env/sync-env-guard";

const configNames = async (
  context: Parameters<Check["run"]>[0],
  deps: PreflightDeps,
): Promise<string[]> => {
  const configs = await deps.run({
    cmd: "doppler",
    args: ["configs"],
    cwd: context.cwd,
    timeoutMs: context.timeoutMs,
  });
  return output(configs)
    .split(/\s+/)
    .filter((part) => /(^|_)(dev|stg|prod|development|staging|production)$/.test(part));
};

const hasAllTiers = (names: string[], tiers: string[]): boolean =>
  tiers.every((tier) =>
    names.some(
      (name) =>
        name.endsWith(`_${tier}`) || name === tier || (tier === "stg" && name.endsWith("_staging")),
    ),
  );

export const createEnvChecks = (deps: PreflightDeps = defaultDeps): Check[] => [
  {
    id: "env/naming",
    name: "Environment naming",
    run: async (context) => {
      const startedAt = Date.now();
      const names = await configNames(context, deps);
      const invalid = names.some(
        (name) => !/(^|_)(dev|stg|prod|development|staging|production)$/.test(name),
      );
      return checkResult(
        "env/naming",
        "Environment naming",
        names.length > 0 && !invalid ? "pass" : "error",
        startedAt,
        {
          hint:
            names.length === 0
              ? "No Doppler configs found."
              : "Doppler config names must use canonical tier suffixes.",
        },
      );
    },
  },
  {
    id: "env/tier-count",
    name: "Environment tier count",
    run: async (context) => {
      const startedAt = Date.now();
      const tiers = readTierNames(context, deps);
      const names = await configNames(context, deps);
      return checkResult(
        "env/tier-count",
        "Environment tier count",
        hasAllTiers(names, tiers) ? "pass" : "error",
        startedAt,
        {
          hint: `Expected Doppler configs for ${tiers.join(", ")}.`,
          evidence: { length: names.length },
        },
      );
    },
  },
  {
    id: "env/doppler-configs",
    name: "Doppler configs",
    run: async (context) => {
      const startedAt = Date.now();
      const tiers = readTierNames(context, deps);
      const names = await configNames(context, deps);
      return checkResult(
        "env/doppler-configs",
        "Doppler configs",
        hasAllTiers(names, tiers) ? "pass" : "error",
        startedAt,
        {
          hint: "Create missing Doppler tier configs.",
          fixable: true,
        },
      );
    },
  },
  {
    id: "env/doppler-key-parity",
    name: "Doppler key parity",
    run: async (context) => {
      const startedAt = Date.now();
      const keys = await deps.run({
        cmd: "doppler",
        args: ["secrets", "--json"],
        cwd: context.cwd,
        timeoutMs: context.timeoutMs,
      });
      return checkResult(
        "env/doppler-key-parity",
        "Doppler key parity",
        ok(keys) ? "pass" : "warn",
        startedAt,
        {
          hint: ok(keys) ? undefined : "Unable to compare non-secret key parity across tiers.",
          fixable: !ok(keys),
        },
      );
    },
  },
  {
    id: "env/github-environments",
    name: "GitHub environments",
    run: async (context) => {
      const startedAt = Date.now();
      const envs = await deps.run({
        cmd: "gh",
        args: ["api", "repos/{owner}/{repo}/environments"],
        cwd: context.cwd,
        timeoutMs: context.timeoutMs,
      });
      return checkResult(
        "env/github-environments",
        "GitHub environments",
        ok(envs) ? "pass" : "warn",
        startedAt,
        {
          hint: ok(envs) ? undefined : "Unable to verify GitHub Environments via gh api.",
          fixable: !ok(envs),
        },
      );
    },
  },
  {
    id: "env/better-auth-url-tier",
    name: "Better Auth URL tier",
    run: async (context) => {
      const startedAt = Date.now();
      const url = await runDopplerSecret(context, deps, "BETTER_AUTH_URL");
      const raw = url.stdout.trim();
      const valid = ok(url) && /^https?:\/\//.test(raw);
      return checkResult(
        "env/better-auth-url-tier",
        "Better Auth URL tier",
        valid ? "pass" : "error",
        startedAt,
        {
          hint: valid ? undefined : "BETTER_AUTH_URL must be set per tier and parse as a URL.",
        },
      );
    },
  },
  {
    id: "env/rotation-age",
    name: "Secret rotation age",
    run: async (context) => {
      const startedAt = Date.now();
      const secrets = await deps.run({
        cmd: "doppler",
        args: ["secrets", "--json"],
        cwd: context.cwd,
        timeoutMs: context.timeoutMs,
      });
      return checkResult(
        "env/rotation-age",
        "Secret rotation age",
        ok(secrets) ? "info" : "skip",
        startedAt,
        {
          hint: ok(secrets)
            ? "Rotation metadata available for follow-up policy checks."
            : "Doppler metadata unavailable.",
        },
      );
    },
  },
  stackCheck("A", "env/render-services", "Render services", deps, async (context, startedAt) => {
    const services = await deps.run({
      cmd: "render",
      args: ["services", "list", "--json"],
      cwd: context.cwd,
      timeoutMs: context.timeoutMs,
    });
    return checkResult(
      "env/render-services",
      "Render services",
      ok(services) || deps.env.RENDER_API_KEY !== undefined ? "pass" : "info",
      startedAt,
      {
        hint: ok(services)
          ? undefined
          : "Render CLI unavailable; set RENDER_API_KEY or verify via MCP.",
      },
    );
  }),
  stackCheck("A", "env/neon-branches", "Neon branches", deps, async (context, startedAt) => {
    const branches = await deps.run({
      cmd: "neonctl",
      args: ["branches", "list", "--output", "json"],
      cwd: context.cwd,
      timeoutMs: context.timeoutMs,
    });
    const status = output(branches).includes("429") ? "warn" : ok(branches) ? "pass" : "error";
    return checkResult("env/neon-branches", "Neon branches", status, startedAt, {
      hint: status === "pass" ? undefined : "Verify Neon branches per tier.",
    });
  }),
  stackCheck(
    "A",
    "env/local-pgsql-dbs",
    "Local PostgreSQL DBs",
    deps,
    async (context, startedAt) => {
      const dbs = await deps.run({
        cmd: "psql",
        args: ["-h", "localhost", "-Atc", "select datname from pg_database"],
        cwd: context.cwd,
        timeoutMs: context.timeoutMs,
      });
      return checkResult(
        "env/local-pgsql-dbs",
        "Local PostgreSQL DBs",
        ok(dbs) ? "pass" : "warn",
        startedAt,
        {
          hint: ok(dbs) ? undefined : "Local PostgreSQL unavailable or missing tier databases.",
          fixable: !ok(dbs),
        },
      );
    },
  ),
  stackCheck(
    "B",
    "env/doppler-vercel-parity",
    "Doppler/Vercel parity",
    deps,
    async (context, startedAt) => {
      const vercel = await deps.run({
        cmd: "vercel",
        args: ["env", "ls", "--json"],
        cwd: context.cwd,
        timeoutMs: context.timeoutMs,
      });
      const doppler = await deps.run({
        cmd: "doppler",
        args: ["secrets", "--json"],
        cwd: context.cwd,
        timeoutMs: context.timeoutMs,
      });
      return checkResult(
        "env/doppler-vercel-parity",
        "Doppler/Vercel parity",
        ok(vercel) && ok(doppler) ? "pass" : "warn",
        startedAt,
        {
          hint: "Compare key names only; never compare secret values.",
        },
      );
    },
  ),
  stackCheck(
    "B",
    "env/convex-deployments",
    "Convex deployments",
    deps,
    async (context, startedAt) => {
      const deployment = await runDopplerSecret(context, deps, "CONVEX_DEPLOYMENT");
      return checkResult(
        "env/convex-deployments",
        "Convex deployments",
        ok(deployment) && deployment.stdout.trim() !== "" ? "pass" : "error",
        startedAt,
        {
          hint: "Set CONVEX_DEPLOYMENT for dev/prod tiers; stg should shadow dev for shared Convex deployments.",
        },
      );
    },
  ),
  createSyncEnvGuardCheck(deps),
  {
    id: "env/ephemeral-teardown",
    name: "Ephemeral teardown",
    run: async (context) => {
      const startedAt = Date.now();
      const prs = await deps.run({
        cmd: "gh",
        args: ["pr", "list", "--state", "open", "--json", "number"],
        cwd: context.cwd,
        timeoutMs: context.timeoutMs,
      });
      const stack = readStack(context, deps);
      const hasPreviewState =
        stack === "B" ? existsSync(join(context.cwd, ".vercel")) : stack === "A";
      return checkResult(
        "env/ephemeral-teardown",
        "Ephemeral teardown",
        ok(prs) && hasPreviewState ? "pass" : "warn",
        startedAt,
        {
          hint: "Could not fully cross-reference ephemeral resources with open PRs.",
        },
      );
    },
  },
];
