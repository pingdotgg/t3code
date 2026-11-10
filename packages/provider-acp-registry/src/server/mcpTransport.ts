import type { AcpRegistrySettings } from "../settings.ts";

// AcpRegistrySupport.validateLocalExecutable refuses .cmd/.bat on Windows, so only native
// executables are launchable.
const COMMAND_CODE_EXECUTABLES = /^(?:cmdc|command-code|commandcode)(?:\.exe)?$/iu;
const COMMAND_CODE_ENTRY_POINTS = [
  /(?:^|[\\/])node_modules[\\/]command-code[\\/]/iu,
  /(?:^|[\\/])command-code[\\/]dist[\\/](?:index|cli)\.mjs$/iu,
];

/**
 * Agents that take T3's MCP endpoint over ACP HTTP: Command Code cannot start the stdio
 * bridge on Windows, where it spawns MCP commands through cmd.exe and the unquoted T3
 * executable path splits at the space.
 */
export function prefersHttpMcpTransport(settings: AcpRegistrySettings): boolean {
  if (settings.source !== "local") {
    return false;
  }
  const executable = settings.commandPath.split(/[\\/]/u).pop() ?? "";
  return (
    COMMAND_CODE_EXECUTABLES.test(executable) ||
    settings.commandArgs.some((argument) =>
      COMMAND_CODE_ENTRY_POINTS.some((pattern) => pattern.test(argument)),
    )
  );
}
