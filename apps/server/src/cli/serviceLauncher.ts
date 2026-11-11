import { main as runServiceLauncher } from "../serviceLauncher.ts";

export async function runServiceLauncherCli(): Promise<void> {
  try {
    await runServiceLauncher();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`[service-launcher] ${message}\n`);
    process.exitCode = 1;
  }
}
