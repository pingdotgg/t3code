const end = "\t\targs: rustCliArgs\n\t});";
// The hook is installed once per machine, so it must patch every Vite+ entrypoint still in use.
// Vite+ 1.8 returns `{ exitCode, devCommand }` from `run` instead of the exit code.
const entrypoints = [
  { start: "\tconst exitCode = await run({", names: "exitCode", assign: "exitCode = await run({" },
  {
    start: "\tconst { exitCode, devCommand } = await run({",
    names: "exitCode, devCommand",
    assign: "({ exitCode, devCommand } = await run({",
  },
];

/** @param {string} source */
export function patchNativeCli(source) {
  if (source.includes('import { startRunHook } from "./run-hook.js";')) return source;
  const entrypoint = entrypoints.find(({ start }) => source.split(start).length === 2);
  if (!entrypoint || source.split(end).length !== 2)
    throw new Error("Unsupported Vite+ entrypoint; no files were changed.");
  const close = entrypoint.assign.startsWith("(") ? "\t}));" : "\t});";
  return (
    'import { startRunHook } from "./run-hook.js";\n' +
    source
      .replace(
        entrypoint.start,
        `\tconst finishRunHook = await startRunHook(command, process.cwd(), async () => (await (await import("../binding/index.js")).detectWorkspace(process.cwd())).root);\n\tif (finishRunHook?.remoteCache && !rustCliArgs.includes("--last-details") && !rustCliArgs.some((arg) => arg === "--remote-cache" || arg.startsWith("--remote-cache="))) { rustCliArgs.splice(1, 0, "--remote-cache", finishRunHook.remoteCache); process.env.VP_T3_TASK_CACHE_MODE = finishRunHook.remoteCache; }\n\tlet ${entrypoint.names};\n\ttry {\n\t${entrypoint.assign}`,
      )
      .replace(
        end,
        `\t\targs: rustCliArgs\n${close}\n\t} finally {\n\t\tawait finishRunHook?.();\n\t}`,
      )
  );
}
