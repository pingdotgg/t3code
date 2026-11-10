import type { AcpRegistrySettings } from "../settings.ts";

const COMMAND_CODE_EXECUTABLES =
  /^(?:cmdc|command-code|commandcode)(?:\.exe|\.cmd|\.bat|\.ps1)?$/iu;
const COMMAND_CODE_PATH_SEGMENT = /(?:^|[\\/])(?:command-code|cmdcode)(?:[\\/]|$)/iu;

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
    settings.commandArgs.some((argument) => COMMAND_CODE_PATH_SEGMENT.test(argument))
  );
}
