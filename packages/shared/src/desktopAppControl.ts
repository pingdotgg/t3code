import { sha256 } from "@noble/hashes/sha2";

export interface DesktopAppControlAddress {
  readonly address: string;
  readonly directory: string | null;
}

function shortHash(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Hash state directories to stay within Unix socket path limits. */
export function resolveDesktopAppControlAddress(input: {
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly tempDir: string;
  readonly userId: number | undefined;
  readonly joinPath: (...segments: readonly string[]) => string;
}): DesktopAppControlAddress {
  const stateHash = shortHash(input.stateDir);
  if (input.platform === "win32") {
    return {
      address: `\\\\.\\pipe\\t3code-app-${stateHash}`,
      directory: null,
    };
  }

  const userKey =
    input.userId === undefined ? shortHash(input.stateDir).slice(0, 12) : input.userId;
  const socketName = `${stateHash}.sock`;
  const maxPathBytes = input.platform === "linux" ? 107 : 103;
  let directory = input.joinPath(input.tempDir, `t3code-${userKey}`);
  if (new TextEncoder().encode(input.joinPath(directory, socketName)).byteLength > maxPathBytes) {
    directory = input.joinPath("/tmp", `t3code-${userKey}`);
  }
  return {
    address: input.joinPath(directory, socketName),
    directory,
  };
}
