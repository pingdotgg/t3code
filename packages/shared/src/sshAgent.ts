// @effect-diagnostics nodeBuiltinImport:off
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface SshAgentSocketStats {
  readonly isSocket: () => boolean;
  readonly mtimeMs?: number;
  readonly uid?: number;
}

export interface SshAuthSockResolverOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly tmpDir?: string;
  readonly currentUid?: number;
  readonly readdir?: (path: string) => ReadonlyArray<string>;
  readonly stat?: (path: string) => SshAgentSocketStats;
}

const VSCODE_SSH_AUTH_SOCK_PATTERN = /^vscode-ssh-auth-[0-9a-fA-F-]+\.sock$/;

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function processUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function sameUserSocket(
  socketPath: string,
  stat: (path: string) => SshAgentSocketStats,
  currentUid: number | undefined,
): SshAgentSocketStats | null {
  try {
    const stats = stat(socketPath);
    if (!stats.isSocket()) return null;
    if (currentUid !== undefined && stats.uid !== undefined && stats.uid !== currentUid) {
      return null;
    }
    return stats;
  } catch {
    return null;
  }
}

function newestSocket(
  candidates: ReadonlyArray<{ readonly path: string; readonly stats: SshAgentSocketStats }>,
): string | undefined {
  let selected: { readonly path: string; readonly mtimeMs: number } | null = null;

  for (const candidate of candidates) {
    const mtimeMs = candidate.stats.mtimeMs ?? 0;
    if (!selected || mtimeMs > selected.mtimeMs) {
      selected = { path: candidate.path, mtimeMs };
    }
  }

  return selected?.path;
}

export function resolveSshAuthSock(options: SshAuthSockResolverOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const inherited = trimNonEmpty(env.SSH_AUTH_SOCK);
  const stat = options.stat ?? ((path: string) => statSync(path));
  const currentUid = options.currentUid ?? processUid();

  if (inherited && sameUserSocket(inherited, stat, currentUid)) {
    return inherited;
  }

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return undefined;
  }

  const directory = options.tmpDir ?? tmpdir();
  const readDirectory = options.readdir ?? ((path: string) => readdirSync(path));
  let entries: ReadonlyArray<string>;
  try {
    entries = readDirectory(directory);
  } catch {
    return undefined;
  }

  const sockets: Array<{ path: string; stats: SshAgentSocketStats }> = [];
  for (const entry of entries) {
    if (!VSCODE_SSH_AUTH_SOCK_PATTERN.test(entry)) continue;

    const socketPath = join(directory, entry);
    const socketStats = sameUserSocket(socketPath, stat, currentUid);
    if (!socketStats) continue;

    sockets.push({ path: socketPath, stats: socketStats });
  }

  return newestSocket(sockets);
}
