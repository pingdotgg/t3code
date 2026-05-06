import { join } from "node:path";

import type { CheckContext } from "../registry";
import type { CheckResult } from "../result";
import type { PreflightDeps } from "../checks/support";
import { checkResult, ok } from "../checks/support";

const readProject = (context: CheckContext, deps: PreflightDeps): string =>
  deps.readText(join(context.cwd, "docs", "project.md")) ?? "";

const hasPlaceholder = (value: string): boolean => /YOUR_|example\.com|\[/.test(value);

const output = (result: Awaited<ReturnType<PreflightDeps["run"]>>): string =>
  ok(result) ? result.stdout.trim() : "";

const isProductionConfig = (config: string): boolean =>
  /(^|\W)(prod|production)(\W|$)/i.test(config);

const deriveSlug = (projectMarkdown: string): string | undefined => {
  const appMatch = /^\s*-\s+\*\*App name\*\*[^:]*:\s*(.+)$/m.exec(projectMarkdown);
  const appName = appMatch?.[1]
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");

  if (appName === undefined || appName === "" || appName.includes("your-")) {
    return undefined;
  }

  return appName;
};

const extractBacktickUrl = (line: string | undefined): string | undefined => {
  if (line === undefined) {
    return undefined;
  }

  const match = /`(https?:\/\/[^`]+)`/.exec(line);
  const url = match?.[1];
  return url === undefined || hasPlaceholder(url) ? undefined : url;
};

export const deriveBetterAuthUrl = (
  projectMarkdown: string,
  environment = "local",
): string | undefined => {
  const localLine = /^\s*-\s+Local:\s+.+$/m.exec(projectMarkdown)?.[0];
  const productionLine = /^\s*-\s+Production:\s+.+$/m.exec(projectMarkdown)?.[0];

  if (/^(prod|production)$/i.test(environment)) {
    const productionUrl = extractBacktickUrl(productionLine);
    if (productionUrl !== undefined) {
      try {
        const parsed = new URL(productionUrl);
        return `https://api.${parsed.host.replace(/^api\./, "")}`;
      } catch {
        return undefined;
      }
    }
  }

  const localApiMatch =
    localLine === undefined
      ? undefined
      : /`(https?:\/\/api\.[^`]+)`\s*\(API\)/.exec(localLine)?.[1];
  if (localApiMatch !== undefined && !hasPlaceholder(localApiMatch)) {
    return localApiMatch;
  }

  const slug = deriveSlug(projectMarkdown);
  return slug === undefined ? undefined : `https://api.${slug}.test`;
};

export const autoDeriveBetterAuthUrl = async (
  context: CheckContext,
  deps: PreflightDeps,
): Promise<CheckResult> => {
  const startedAt = Date.now();
  const existing = await deps.run({
    cmd: "doppler",
    args: ["secrets", "get", "BETTER_AUTH_URL", "--plain"],
    cwd: context.cwd,
    timeoutMs: context.timeoutMs,
  });

  if (ok(existing) && existing.stdout.trim() !== "") {
    return checkResult(
      "fix/auto-derive/BETTER_AUTH_URL",
      "Derive Better Auth URL",
      "skip",
      startedAt,
      {
        hint: "BETTER_AUTH_URL is already set; refusing to overwrite it.",
      },
    );
  }

  const derived = deriveBetterAuthUrl(
    readProject(context, deps),
    deps.env.PREFLIGHT_BETTER_AUTH_ENV ?? "local",
  );
  if (derived === undefined) {
    return checkResult(
      "fix/auto-derive/BETTER_AUTH_URL",
      "Derive Better Auth URL",
      "error",
      startedAt,
      {
        hint: "Initialize docs/project.md App name before deriving BETTER_AUTH_URL.",
      },
    );
  }

  const config = output(
    await deps.run({
      cmd: "doppler",
      args: ["configure", "get"],
      cwd: context.cwd,
      timeoutMs: context.timeoutMs,
    }),
  );
  const targetEnvironment = deps.env.PREFLIGHT_BETTER_AUTH_ENV ?? "";
  if (
    (isProductionConfig(config) || isProductionConfig(targetEnvironment)) &&
    deps.env.PREFLIGHT_CONFIRM_PROD_WRITE !== "1"
  ) {
    return checkResult(
      "fix/auto-derive/BETTER_AUTH_URL",
      "Derive Better Auth URL",
      "error",
      startedAt,
      {
        hint: "Production Doppler writes require PREFLIGHT_CONFIRM_PROD_WRITE=1.",
      },
    );
  }

  const written = await deps.run({
    cmd: "doppler",
    args: ["secrets", "set", "BETTER_AUTH_URL", "--no-interactive", "--silent"],
    cwd: context.cwd,
    timeoutMs: context.timeoutMs,
    input: derived,
  });

  return checkResult(
    "fix/auto-derive/BETTER_AUTH_URL",
    "Derive Better Auth URL",
    ok(written) ? "pass" : "error",
    startedAt,
    {
      hint: ok(written)
        ? "BETTER_AUTH_URL derived and written via Doppler stdin."
        : "Failed to write BETTER_AUTH_URL via Doppler stdin.",
    },
  );
};
