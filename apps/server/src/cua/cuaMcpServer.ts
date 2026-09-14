import type { CuaDriverMcpConfiguration } from "@t3tools/contracts";

/** Server name every provider sees; user configuration under the same name wins. */
export const CUA_MCP_SERVER_NAME = "cua-driver";

export const cuaEnvironmentRecord = (
  descriptor: CuaDriverMcpConfiguration,
): Record<string, string> =>
  Object.fromEntries(descriptor.environment.map(({ name, value }) => [name, value]));

/** ACP stdio server shape shared by Cursor, Grok, and Antigravity. */
export const cuaAcpMcpServer = (descriptor: CuaDriverMcpConfiguration) => ({
  name: CUA_MCP_SERVER_NAME,
  command: descriptor.command,
  args: [...descriptor.args],
  env: descriptor.environment.map(({ name, value }) => ({ name, value })),
});

export const cuaClaudeMcpServer = (descriptor: CuaDriverMcpConfiguration) => ({
  type: "stdio" as const,
  command: descriptor.command,
  args: [...descriptor.args],
  env: cuaEnvironmentRecord(descriptor),
});

export const cuaOpenCodeMcpConfig = (descriptor: CuaDriverMcpConfiguration) => ({
  type: "local" as const,
  command: [descriptor.command, ...descriptor.args],
  environment: cuaEnvironmentRecord(descriptor),
});
