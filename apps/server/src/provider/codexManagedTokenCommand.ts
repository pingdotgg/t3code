// @effect-diagnostics globalFetch:off - import-free CLI fast path that runs before any Effect runtime exists.
/**
 * `t3 codex-managed-token` — internal credential command for managed Codex.
 *
 * Codex runs it again when its cached bearer expires or receives a 401. It
 * reads the provider's loopback bridge from the environment and prints the
 * current token, so the child holds a bridge credential and never a fixed copy
 * of the provider token. Kept free of imports: bin.ts dispatches it before the
 * CLI module graph loads, and Codex re-runs it on a short interval.
 */
export const codexManagedTokenCommandName = "codex-managed-token";

export async function runCodexManagedTokenCommand(): Promise<void> {
  try {
    const response = await fetch(process.env.T3CODE_MANAGED_CODEX_AUTH_URL ?? "", {
      headers: {
        Authorization: `Bearer ${process.env.T3CODE_MANAGED_CODEX_AUTH_SECRET}`,
        "X-T3-Codex-Account": process.env.T3CODE_MANAGED_CODEX_AUTH_ACCOUNT ?? "",
      },
    });
    if (!response.ok) throw new Error();
    process.stdout.write(await response.text());
  } catch {
    process.stderr.write("Could not renew managed Codex credentials.\n");
    process.exitCode = 1;
  }
}
