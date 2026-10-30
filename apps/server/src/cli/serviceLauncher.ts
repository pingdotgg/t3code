import { type LauncherOptions, main as runServiceLauncher } from "../serviceLauncher.ts";

export async function runServiceLauncherCli(options?: LauncherOptions): Promise<void> {
  try {
    await runServiceLauncher(options);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`[service-launcher] ${message}\n`);
    process.exitCode = 1;
  }
}
