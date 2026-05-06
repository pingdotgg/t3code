import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import latestVersions from "../latest-versions.json";
import type { Check, CheckContext } from "../registry";
import type { CheckResult, CheckStatus } from "../result";
import { runCli, type RunCliOptions, type RunCliResult } from "../run-cli";
import { classifyVersion } from "../version-policy";

export type IntegrationDeps = {
  env: Record<string, string | undefined>;
  readText: (path: string) => string | undefined;
  run: (options: RunCliOptions) => Promise<RunCliResult>;
};

const defaultDeps: IntegrationDeps = {
  env: process.env,
  readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
  run: runCli,
};

const result = (
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

const ok = (cli: RunCliResult): boolean => cli.exitCode === 0 && !cli.timedOut;
const output = (cli: RunCliResult): string => `${cli.stdout}\n${cli.stderr}`.trim();

const readProjectAppName = (context: CheckContext, deps: IntegrationDeps): string | undefined => {
  const project = deps.readText(join(context.cwd, "docs", "project.md")) ?? "";
  const match = /^\s*-\s+\*\*App name\*\*[^:]*:\s*(.+)$/m.exec(project);
  const appName = match?.[1]?.trim();
  return appName === undefined || appName.includes("YOUR_") ? undefined : appName;
};

const dopplerSecret = async (
  context: CheckContext,
  deps: IntegrationDeps,
  key: string,
): Promise<RunCliResult> =>
  deps.run({
    cmd: "doppler",
    args: ["secrets", "get", key, "--plain"],
    cwd: context.cwd,
    timeoutMs: context.timeoutMs,
  });

const makeSecretCheck = (
  deps: IntegrationDeps,
  id: string,
  name: string,
  key: string,
  optional: boolean,
  minLength = 1,
): Check => ({
  id,
  name,
  run: async (context) => {
    const startedAt = Date.now();
    const secret = await dopplerSecret(context, deps, key);
    const value = secret.stdout.trim();

    if (!ok(secret) || value === "") {
      return result(id, name, optional ? "warn" : "error", startedAt, {
        hint: `${key} is missing from Doppler.`,
        fixable: !optional,
      });
    }

    if (value.length < minLength) {
      return result(id, name, "error", startedAt, {
        hint: `${key} is shorter than ${minLength} characters.`,
        fixable: !optional,
        evidence: { length: value.length },
      });
    }

    return result(id, name, "pass", startedAt, { evidence: { length: value.length } });
  },
});

export const createIntegrationChecks = (deps: IntegrationDeps = defaultDeps): Check[] => [
  {
    id: "doppler/cli",
    name: "Doppler CLI",
    run: async (context) => {
      const startedAt = Date.now();
      const version = await deps.run({
        cmd: "doppler",
        args: ["--version"],
        cwd: context.cwd,
        timeoutMs: context.timeoutMs,
      });
      if (!ok(version)) {
        return result("doppler/cli", "Doppler CLI", "error", startedAt, {
          hint: "Install and authenticate the Doppler CLI.",
        });
      }

      const classified = classifyVersion(output(version), latestVersions.doppler);
      const configured = await deps.run({
        cmd: "doppler",
        args: ["configure", "get"],
        cwd: context.cwd,
        timeoutMs: context.timeoutMs,
      });
      if (!ok(configured)) {
        return result("doppler/cli", "Doppler CLI", "error", startedAt, {
          hint: "Run doppler setup for this repository.",
        });
      }

      return result("doppler/cli", "Doppler CLI", classified.status, startedAt, {
        hint: classified.hint,
        evidence: { version: output(version) },
      });
    },
  },
  {
    id: "doppler/auth",
    name: "Doppler authentication",
    run: async (context) => {
      const startedAt = Date.now();
      const auth = await deps.run({
        cmd: "doppler",
        args: ["me", "--json"],
        cwd: context.cwd,
        timeoutMs: context.timeoutMs,
      });
      return result(
        "doppler/auth",
        "Doppler authentication",
        ok(auth) ? "pass" : "error",
        startedAt,
        {
          hint: ok(auth)
            ? undefined
            : "Run doppler login; the current token is missing or expired.",
        },
      );
    },
  },
  {
    id: "doppler/yaml",
    name: "Doppler YAML",
    run: (context) => {
      const startedAt = Date.now();
      const candidates = ["doppler.yaml", "apps/api/doppler.yaml", "apps/web/doppler.yaml"];
      const files = candidates
        .map((path) => deps.readText(join(context.cwd, path)))
        .filter((text): text is string => text !== undefined);
      const hasPlaceholder = files.some((text) => {
        const liveYaml = text
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("#"))
          .join("\n");
        return liveYaml.includes("YOUR_PROJECT_NAME") || liveYaml.includes("my-project");
      });
      return result(
        "doppler/yaml",
        "Doppler YAML",
        files.length > 0 && !hasPlaceholder ? "pass" : "error",
        startedAt,
        {
          hint:
            files.length === 0
              ? "Add per-app doppler.yaml files."
              : "Replace placeholder Doppler project names.",
        },
      );
    },
  },
  makeSecretCheck(
    deps,
    "better-auth/secret",
    "Better Auth secret",
    "BETTER_AUTH_SECRET",
    false,
    32,
  ),
  {
    id: "better-auth/url",
    name: "Better Auth URL",
    run: async (context) => {
      const startedAt = Date.now();
      const secret = await dopplerSecret(context, deps, "BETTER_AUTH_URL");
      const raw = secret.stdout.trim();
      if (!ok(secret) || raw === "") {
        return result("better-auth/url", "Better Auth URL", "error", startedAt, {
          hint: "BETTER_AUTH_URL is missing from Doppler.",
          fixable: true,
        });
      }

      try {
        const parsed = new URL(raw);
        const appName = readProjectAppName(context, deps);
        const matchesApp = appName === undefined || parsed.host.includes(appName);
        return result(
          "better-auth/url",
          "Better Auth URL",
          matchesApp ? "pass" : "error",
          startedAt,
          {
            hint: matchesApp
              ? undefined
              : "BETTER_AUTH_URL host does not match docs/project.md app name.",
            fixable: !matchesApp,
            evidence: { url: parsed.origin },
          },
        );
      } catch {
        return result("better-auth/url", "Better Auth URL", "error", startedAt, {
          hint: "BETTER_AUTH_URL must be a valid URL.",
          fixable: true,
        });
      }
    },
  },
  {
    id: "github/cli",
    name: "GitHub CLI",
    run: async (context) => {
      const startedAt = Date.now();
      const auth = await deps.run({
        cmd: "gh",
        args: ["auth", "status", "--json", "hosts"],
        cwd: context.cwd,
        timeoutMs: context.timeoutMs,
      });
      const text = output(auth);
      const status = !ok(auth) ? "error" : text.includes("repo") ? "pass" : "warn";
      return result("github/cli", "GitHub CLI", status, startedAt, {
        hint: status === "pass" ? undefined : "Run gh auth login with repo scope.",
      });
    },
  },
  makeSecretCheck(deps, "sentry/dsn", "Sentry DSN", "SENTRY_DSN", true),
  makeSecretCheck(deps, "resend/key", "Resend API key", "RESEND_API_KEY", true),
  {
    id: "ai-loop/secrets",
    name: "AI loop secrets",
    run: (context) => {
      const startedAt = Date.now();
      const config = deps.readText(join(context.cwd, ".github", "ai-loop.yml")) ?? "";
      if (!/"enabled"\s*:\s*true|enabled:\s*true/.test(config)) {
        return result("ai-loop/secrets", "AI loop secrets", "skip", startedAt, {
          hint: "ai-loop is disabled.",
        });
      }

      const hasApp =
        deps.env.AI_FIX_APP_ID !== undefined && deps.env.AI_FIX_APP_PRIVATE_KEY !== undefined;
      const hasModelToken =
        deps.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined || deps.env.ANTHROPIC_API_KEY !== undefined;
      return result(
        "ai-loop/secrets",
        "AI loop secrets",
        hasApp && hasModelToken ? "pass" : "error",
        startedAt,
        {
          hint:
            hasApp && hasModelToken
              ? undefined
              : "Set AI_FIX_APP_ID, AI_FIX_APP_PRIVATE_KEY, and a Claude/Anthropic token.",
        },
      );
    },
  },
];
