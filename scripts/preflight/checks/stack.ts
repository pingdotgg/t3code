import { existsSync } from "node:fs";
import { join } from "node:path";

import latestVersions from "../latest-versions.json";
import type { Check } from "../registry";
import { classifyVersion } from "../version-policy";
import {
  checkResult,
  defaultDeps,
  ok,
  output,
  runDopplerSecret,
  stackCheck,
  type PreflightDeps,
} from "./support";

export const createStackChecks = (deps: PreflightDeps = defaultDeps): Check[] => [
  stackCheck("A", "stack-a/neon-url", "Neon URL", deps, async (context, startedAt) => {
    const databaseUrl = await runDopplerSecret(context, deps, "DATABASE_URL");
    if (!ok(databaseUrl) || !databaseUrl.stdout.trim().startsWith("postgres")) {
      return checkResult("stack-a/neon-url", "Neon URL", "error", startedAt, {
        hint: "DATABASE_URL must be present in Doppler and use postgres/postgresql.",
      });
    }

    const neon = await deps.run({
      cmd: "neonctl",
      args: ["branches", "list", "--output", "json"],
      cwd: context.cwd,
      timeoutMs: context.timeoutMs,
    });
    return checkResult("stack-a/neon-url", "Neon URL", ok(neon) ? "pass" : "warn", startedAt, {
      hint: ok(neon)
        ? undefined
        : "DATABASE_URL is shaped correctly, but neonctl branch probe did not pass.",
    });
  }),
  stackCheck("A", "stack-a/render-cli", "Render CLI/API", deps, async (context, startedAt) => {
    const version = await deps.run({
      cmd: "render",
      args: ["--version"],
      cwd: context.cwd,
      timeoutMs: context.timeoutMs,
    });
    if (ok(version)) {
      const classified = classifyVersion(output(version), latestVersions.render);
      return checkResult("stack-a/render-cli", "Render CLI/API", classified.status, startedAt, {
        hint: classified.hint,
        evidence: { version: output(version) },
      });
    }

    if (deps.env.RENDER_API_KEY !== undefined) {
      return checkResult("stack-a/render-cli", "Render CLI/API", "info", startedAt, {
        hint: "Render API key present; CLI is optional.",
      });
    }

    if (deps.env.RENDER_MCP_AVAILABLE === "1") {
      return checkResult("stack-a/render-cli", "Render CLI/API", "info", startedAt, {
        hint: "Render MCP available; skipping local CLI probe.",
      });
    }

    return checkResult("stack-a/render-cli", "Render CLI/API", "error", startedAt, {
      hint: "Install Render CLI or provide RENDER_API_KEY.",
    });
  }),
  stackCheck("B", "stack-b/convex-cli", "Convex CLI", deps, async (context, startedAt) => {
    const version = await deps.run({
      cmd: "bunx",
      args: ["convex", "--version"],
      cwd: context.cwd,
      timeoutMs: context.timeoutMs,
    });
    const deployment = await runDopplerSecret(context, deps, "CONVEX_DEPLOYMENT");
    if (!ok(version) || !ok(deployment) || deployment.stdout.trim() === "") {
      return checkResult("stack-b/convex-cli", "Convex CLI", "error", startedAt, {
        hint: "Convex CLI and CONVEX_DEPLOYMENT are required.",
      });
    }

    return checkResult("stack-b/convex-cli", "Convex CLI", "pass", startedAt, {
      evidence: { version: output(version) },
    });
  }),
  stackCheck(
    "B",
    "stack-b/convex-deployment",
    "Convex deployment",
    deps,
    async (context, startedAt) => {
      const probe = await deps.run({
        cmd: "bunx",
        args: ["convex", "dev", "--once", "--typecheck=disable"],
        cwd: context.cwd,
        timeoutMs: Math.min(context.timeoutMs, 10000),
      });
      return checkResult(
        "stack-b/convex-deployment",
        "Convex deployment",
        ok(probe) ? "pass" : "error",
        startedAt,
        {
          hint: ok(probe) ? undefined : "Convex development deployment probe failed.",
        },
      );
    },
  ),
  stackCheck("B", "stack-b/vercel-cli", "Vercel CLI", deps, async (context, startedAt) => {
    const version = await deps.run({
      cmd: "vercel",
      args: ["--version"],
      cwd: context.cwd,
      timeoutMs: context.timeoutMs,
    });
    const whoami = await deps.run({
      cmd: "vercel",
      args: ["whoami", "--json"],
      cwd: context.cwd,
      timeoutMs: context.timeoutMs,
    });
    if (!ok(version) || !ok(whoami)) {
      return checkResult("stack-b/vercel-cli", "Vercel CLI", "error", startedAt, {
        hint: "Install Vercel CLI and run vercel login.",
      });
    }

    const classified = classifyVersion(output(version), latestVersions.vercel);
    return checkResult("stack-b/vercel-cli", "Vercel CLI", classified.status, startedAt, {
      hint: classified.hint,
      evidence: { version: output(version) },
    });
  }),
  stackCheck("B", "stack-b/vercel-link", "Vercel link", deps, (context, startedAt) => {
    const linked = existsSync(join(context.cwd, ".vercel", "project.json"));
    return Promise.resolve(
      checkResult("stack-b/vercel-link", "Vercel link", linked ? "pass" : "error", startedAt, {
        hint: linked ? undefined : "Run vercel link in a TTY to create .vercel/project.json.",
        fixable: !linked,
      }),
    );
  }),
];
