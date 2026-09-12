// Standalone launcher entry for npm-distributed runtimes: `node
// service-launcher.mjs`. Archive runtimes reach the same code through the
// `t3 __service-launcher` subcommand, so serviceLauncher.ts itself must not run
// anything on import.
import { isEntrypoint } from "./entrypoint.ts";
import { main } from "./serviceLauncher.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  main().catch((cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    process.stderr.write(`[service-launcher] ${error.message}\n`);
    process.exitCode = 1;
  });
}
