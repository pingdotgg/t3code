import { randomBytes } from "node:crypto";

import type { CheckContext } from "../registry";
import type { CheckResult } from "../result";
import type { PreflightDeps } from "../checks/support";
import { checkResult, ok, output } from "../checks/support";

export const generateSecret = (): string => randomBytes(48).toString("base64url");

const currentConfig = async (context: CheckContext, deps: PreflightDeps): Promise<string> => {
  const configured = await deps.run({
    cmd: "doppler",
    args: ["configure", "get"],
    cwd: context.cwd,
    timeoutMs: context.timeoutMs,
  });
  return output(configured);
};

const isProductionConfig = (config: string): boolean =>
  /(^|\W)(prod|production)(\W|$)/i.test(config);

export const autoGenerateSecret = async (
  context: CheckContext,
  deps: PreflightDeps,
  key: string,
): Promise<CheckResult> => {
  const startedAt = Date.now();
  const existing = await deps.run({
    cmd: "doppler",
    args: ["secrets", "get", key, "--plain"],
    cwd: context.cwd,
    timeoutMs: context.timeoutMs,
  });

  if (ok(existing) && existing.stdout.trim() !== "") {
    return checkResult(`fix/auto-generate/${key}`, `Generate ${key}`, "skip", startedAt, {
      hint: `${key} is already set; refusing to overwrite it.`,
    });
  }

  const config = await currentConfig(context, deps);
  if (isProductionConfig(config) && deps.env.PREFLIGHT_CONFIRM_PROD_WRITE !== "1") {
    return checkResult(`fix/auto-generate/${key}`, `Generate ${key}`, "error", startedAt, {
      hint: "Production Doppler writes require PREFLIGHT_CONFIRM_PROD_WRITE=1.",
    });
  }

  const created = await deps.run({
    cmd: "doppler",
    args: ["secrets", "set", key, "--no-interactive", "--silent"],
    cwd: context.cwd,
    timeoutMs: context.timeoutMs,
    input: generateSecret(),
  });

  return checkResult(
    `fix/auto-generate/${key}`,
    `Generate ${key}`,
    ok(created) ? "pass" : "error",
    startedAt,
    {
      hint: ok(created)
        ? `${key} generated in Doppler.`
        : `Failed to write ${key} via Doppler stdin.`,
    },
  );
};
