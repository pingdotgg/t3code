// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";

export function vitePlusCommand(
  args: ReadonlyArray<string>,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime; tests pass the platform explicitly.
  platform: NodeJS.Platform = process.platform,
): [command: string, args: Array<string>] {
  // Windows cannot spawn the package manager's vp.cmd shim without a shell.
  // Use Vite+'s exported JS entry with this Node instead, keeping paths and
  // arguments literal. Resolve here, not from the patch check's temporary cwd.
  if (platform === "win32") {
    return [
      process.execPath,
      [NodeURL.fileURLToPath(import.meta.resolve("vite-plus/bin")), ...args],
    ];
  }
  return ["vp", [...args]];
}
