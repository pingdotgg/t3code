/**
 * Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session, and terminal-fallback
 * agents run `t3 acp-mcp-call` per tool call, so their startup sits on first-message latency.
 * Both dispatch here before the full CLI module graph (seconds of evaluation) loads; everything
 * else defers to the real CLI in ./binCli.ts.
 */
import packageJson from "../package.json" with { type: "json" };
import * as NodeSea from "node:sea";
import { enableCliCompileCache } from "./cliCompileCache.ts";
import { isEntrypoint } from "./entrypoint.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  const command = process.argv[2];
  // Helpers omit --base-dir; browser setup may run as root. Avoid caching in the wrong home.
  const uncached =
    command === "__spawn-host" ||
    command === "__load-bundle" ||
    command === "__claude-history" ||
    command === "acp-mcp-bridge" ||
    command === "acp-mcp-call" ||
    command === "browser";
  if (!(process.argv.length === 3 && command === "--version") && !uncached) {
    enableCliCompileCache({
      bundled: NodeSea.isSea() || import.meta.url.endsWith(".mjs"),
      argv: process.argv.slice(2),
      environment: process.env,
      version: packageJson.version,
    });
  }
  if (process.argv.length === 3 && command === "--version") {
    process.stdout.write(`t3 v${packageJson.version}\n`);
  } else if (command === "--bootstrap-fd" || command?.startsWith("--bootstrap-fd=")) {
    const { runLightCli } = await import("./binLightCli.ts");
    await runLightCli("desktop");
  } else if (
    command === "pair" ||
    command === "auth" ||
    command === "service" ||
    command === "project" ||
    command === "serve" ||
    command === "start"
  ) {
    const { runLightCli } = await import("./binLightCli.ts");
    await runLightCli(command);
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else if (command === "__spawn-host") {
    const { runSpawnHost } = await import("./process/spawnHostProcess.ts");
    runSpawnHost();
  } else if (command === "__load-bundle") {
    const { loadBundle } = await import("./loadBundle.ts");
    const chunks = await loadBundle(import.meta.url);
    process.stdout.write(`t3 v${packageJson.version}: loaded ${chunks} bundle chunks\n`);
    // A chunk may start timers or handles at load, as it would in the server.
    process.exit(0);
  } else {
    // Before anything reads stdin: the desktop app's Windows launcher starts
    // the CLI without one. Never for the fast paths, whose stdin is a pipe.
    const { attachConsoleStdin } = await import("./cli/consoleStdin.ts");
    attachConsoleStdin();
    const { runCli } = await import("./binCli.ts");
    runCli();
  }
}
