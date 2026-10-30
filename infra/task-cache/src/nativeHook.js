/** @param {string} source */
export function patchNativeCli(source) {
  if (source.includes('import { startRunHook } from "./run-hook.js";')) return source;
  const start = "\tconst exitCode = await run({";
  const end = "\t\targs: rustCliArgs\n\t});";
  if (source.split(start).length !== 2 || source.split(end).length !== 2)
    throw new Error("Unsupported Vite+ entrypoint; no files were changed.");
  return (
    'import { startRunHook } from "./run-hook.js";\n' +
    source
      .replace(
        start,
        '\tconst finishRunHook = await startRunHook(command, process.cwd(), async () => (await (await import("../binding/index.js")).detectWorkspace(process.cwd())).root);\n\tif (finishRunHook?.remoteCache && !rustCliArgs.includes("--last-details") && !rustCliArgs.some((arg) => arg === "--remote-cache" || arg.startsWith("--remote-cache="))) { rustCliArgs.splice(1, 0, "--remote-cache", finishRunHook.remoteCache); process.env.VP_T3_TASK_CACHE_MODE = finishRunHook.remoteCache; }\n\tlet exitCode;\n\ttry {\n\texitCode = await run({',
      )
      .replace(end, end + "\n\t} finally {\n\t\tawait finishRunHook?.();\n\t}")
  );
}
