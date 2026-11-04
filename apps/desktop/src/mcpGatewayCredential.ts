// @effect-diagnostics nodeBuiltinImport:off - the synchronous preload bootstrap needs a synchronous, fail-closed credential read.
import * as NodeCrypto from "node:crypto";
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

const credentialFile = (homeDirectory: string) =>
  NodePath.join(homeDirectory, ".config", "t3code", "mcp-gateway.env");

export function readMcpGatewayBridgeToken(source: McpGatewayCredentialSource): string | null {
  const environmentToken = validateToken(source.env.T3_MCP_BRIDGE_TOKEN);
  if (environmentToken !== null) return environmentToken;

  const credentialPath = credentialFile(source.homeDirectory);
  try {
    const file = source.statFile(credentialPath);
    if (!file.isFile() || (source.userId !== null && file.uid !== source.userId)) return null;
    if ((file.mode & 0o077) !== 0) return null;
    return parseTokenEnvironmentFile(source.readFileString(credentialPath));
  } catch {
    return null;
  }
}

export interface McpGatewayCredentialStore extends McpGatewayCredentialSource {
  readonly makeDirectory: (path: string) => void;
  /** Creates the file only if it does not exist yet. */
  readonly createFileExclusive: (path: string, contents: string) => void;
  readonly newToken: () => string;
}

/**
 * The token, creating the protected env file when there is none, so an enabled gateway keeps
 * the same token across restarts. A file that exists but is unusable is left for its owner to fix.
 */
export function ensureMcpGatewayBridgeToken(store: McpGatewayCredentialStore): string | null {
  const existing = readMcpGatewayBridgeToken(store);
  if (existing !== null) return existing;
  const credentialPath = credentialFile(store.homeDirectory);
  try {
    store.makeDirectory(NodePath.dirname(credentialPath));
    store.createFileExclusive(
      credentialPath,
      `${TOKEN_ENVIRONMENT_VARIABLE}=${store.newToken()}\n`,
    );
  } catch {
    // Another window created it first, or it cannot be written; the read below decides.
  }
  return readMcpGatewayBridgeToken(store);
}

const processCredentialSource = (homeDirectory: string): McpGatewayCredentialStore => ({
  env: process.env,
  homeDirectory,
  userId: typeof process.getuid === "function" ? process.getuid() : null,
  statFile: NodeFS.statSync,
  readFileString: (path) => NodeFS.readFileSync(path, "utf8"),
  makeDirectory: (path) => NodeFS.mkdirSync(path, { recursive: true, mode: 0o700 }),
  createFileExclusive: (path, contents) =>
    NodeFS.writeFileSync(path, contents, { flag: "wx", mode: 0o600 }),
  newToken: () => NodeCrypto.randomBytes(32).toString("hex"),
});

export function readMcpGatewayBridgeTokenFromProcess(homeDirectory: string): string | null {
  return readMcpGatewayBridgeToken(processCredentialSource(homeDirectory));
}

export function ensureMcpGatewayBridgeTokenFromProcess(homeDirectory: string): string | null {
  return ensureMcpGatewayBridgeToken(processCredentialSource(homeDirectory));
}
