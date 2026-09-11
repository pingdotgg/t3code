// @effect-diagnostics nodeBuiltinImport:off - the synchronous preload bootstrap needs a synchronous, fail-closed credential read.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const TOKEN_ENVIRONMENT_VARIABLE = "T3_MCP_BRIDGE_TOKEN";
const MINIMUM_TOKEN_LENGTH = 16;

interface CredentialFileInfo {
  readonly mode: number;
  readonly uid: number;
  isFile(): boolean;
}

export interface McpGatewayCredentialSource {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly userId: number | null;
  readonly statFile: (path: string) => CredentialFileInfo;
  readonly readFileString: (path: string) => string;
}

function validateToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const token = value.trim();
  return token.length >= MINIMUM_TOKEN_LENGTH && !/\s/u.test(token) ? token : null;
}

function parseTokenEnvironmentFile(contents: string): string | null {
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const prefix = `${TOKEN_ENVIRONMENT_VARIABLE}=`;
    if (!line.startsWith(prefix)) continue;

    const encoded = line.slice(prefix.length).trim();
    if (encoded.startsWith('"') || encoded.startsWith("'")) {
      const quote = encoded[0];
      if (encoded.length < 2 || encoded.at(-1) !== quote) return null;
      return validateToken(encoded.slice(1, -1));
    }
    return validateToken(encoded);
  }
  return null;
}

export function readMcpGatewayBridgeToken(source: McpGatewayCredentialSource): string | null {
  const environmentToken = validateToken(source.env.T3_MCP_BRIDGE_TOKEN);
  if (environmentToken !== null) return environmentToken;

  const credentialPath = NodePath.join(
    source.homeDirectory,
    ".config",
    "t3code",
    "mcp-gateway.env",
  );
  try {
    const file = source.statFile(credentialPath);
    if (!file.isFile() || (source.userId !== null && file.uid !== source.userId)) return null;
    if (source.userId !== null && (file.mode & 0o077) !== 0) return null;
    return parseTokenEnvironmentFile(source.readFileString(credentialPath));
  } catch {
    return null;
  }
}

export function readMcpGatewayBridgeTokenFromProcess(homeDirectory: string): string | null {
  return readMcpGatewayBridgeToken({
    env: process.env,
    homeDirectory,
    userId: typeof process.getuid === "function" ? process.getuid() : null,
    statFile: NodeFS.statSync,
    readFileString: (path) => NodeFS.readFileSync(path, "utf8"),
  });
}
