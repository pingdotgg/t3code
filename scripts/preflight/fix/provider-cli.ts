import type { CheckContext } from "../registry";
import type { CheckResult } from "../result";
import type { PreflightDeps } from "../checks/support";
import { checkResult, ok } from "../checks/support";

export type ProviderCliAction = "convex-dev" | "vercel-link" | "neon-project-create";

export const providerCliCommand = (action: ProviderCliAction): string[] => {
  if (action === "convex-dev") {
    return ["bunx", "convex", "dev", "--once", "--typecheck=disable"];
  }

  if (action === "vercel-link") {
    return ["vercel", "link"];
  }

  return ["neonctl", "projects", "create"];
};

export const runProviderCli = async (
  context: CheckContext,
  deps: PreflightDeps,
  action: ProviderCliAction,
): Promise<CheckResult> => {
  const startedAt = Date.now();
  const command = providerCliCommand(action);
  const cmd = command[0];
  const args = command.slice(1);

  if (cmd === undefined) {
    return checkResult(`fix/provider-cli/${action}`, "Provider CLI bootstrap", "error", startedAt, {
      hint: `No provider command is configured for ${action}.`,
    });
  }

  if (deps.env.PREFLIGHT_TTY !== "1") {
    return checkResult(`fix/provider-cli/${action}`, "Provider CLI bootstrap", "error", startedAt, {
      hint: `Run manually in a TTY: ${command.join(" ")}`,
    });
  }

  const result = await deps.run({ cmd, args, cwd: context.cwd, timeoutMs: context.timeoutMs });
  return checkResult(
    `fix/provider-cli/${action}`,
    "Provider CLI bootstrap",
    ok(result) ? "pass" : "error",
    startedAt,
    {
      hint: ok(result) ? undefined : `Provider command failed: ${command.join(" ")}`,
    },
  );
};
