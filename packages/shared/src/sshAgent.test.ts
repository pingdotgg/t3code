import { describe, expect, it, vi } from "vite-plus/test";
import { resolveSshAuthSock, type SshAgentSocketStats } from "./sshAgent.ts";

function socketStats(input: {
  readonly uid?: number;
  readonly mtimeMs?: number;
  readonly socket?: boolean;
}): SshAgentSocketStats {
  return {
    isSocket: () => input.socket ?? true,
    ...(input.mtimeMs !== undefined ? { mtimeMs: input.mtimeMs } : {}),
    ...(input.uid !== undefined ? { uid: input.uid } : {}),
  };
}

describe("resolveSshAuthSock", () => {
  it("keeps a valid inherited SSH_AUTH_SOCK without scanning temp", () => {
    const readdir = vi.fn<() => ReadonlyArray<string>>(() => []);
    const stat = vi.fn<(path: string) => SshAgentSocketStats>(() =>
      socketStats({ uid: 1000, mtimeMs: 1 }),
    );

    expect(
      resolveSshAuthSock({
        env: { SSH_AUTH_SOCK: "/tmp/inherited.sock" },
        platform: "linux",
        currentUid: 1000,
        readdir,
        stat,
      }),
    ).toBe("/tmp/inherited.sock");
    expect(stat).toHaveBeenCalledWith("/tmp/inherited.sock");
    expect(readdir).not.toHaveBeenCalled();
  });

  it("finds the newest same-user VS Code forwarded SSH agent socket", () => {
    const readdir = vi.fn<() => ReadonlyArray<string>>(() => [
      "vscode-ssh-auth-11111111-1111-1111-1111-111111111111.sock",
      "vscode-ssh-auth-22222222-2222-2222-2222-222222222222.sock",
      "vscode-ssh-auth-33333333-3333-3333-3333-333333333333.sock",
      "unrelated.sock",
    ]);
    const stat = vi.fn<(path: string) => SshAgentSocketStats>((path) => {
      if (path.endsWith("111111111111.sock")) {
        return socketStats({ uid: 1000, mtimeMs: 10 });
      }
      if (path.endsWith("222222222222.sock")) {
        return socketStats({ uid: 1000, mtimeMs: 20 });
      }
      return socketStats({ uid: 1000, mtimeMs: 30, socket: false });
    });

    expect(
      resolveSshAuthSock({
        env: {},
        platform: "linux",
        tmpDir: "/tmp",
        currentUid: 1000,
        readdir,
        stat,
      }),
    ).toBe("/tmp/vscode-ssh-auth-22222222-2222-2222-2222-222222222222.sock");
  });

  it("falls back from a stale inherited socket to a discovered VS Code socket", () => {
    const readdir = vi.fn<() => ReadonlyArray<string>>(() => [
      "vscode-ssh-auth-11111111-1111-1111-1111-111111111111.sock",
    ]);
    const stat = vi.fn<(path: string) => SshAgentSocketStats>((path) => {
      if (path === "/tmp/stale.sock") {
        throw new Error("missing");
      }
      return socketStats({ uid: 1000, mtimeMs: 10 });
    });

    expect(
      resolveSshAuthSock({
        env: { SSH_AUTH_SOCK: "/tmp/stale.sock" },
        platform: "linux",
        tmpDir: "/tmp",
        currentUid: 1000,
        readdir,
        stat,
      }),
    ).toBe("/tmp/vscode-ssh-auth-11111111-1111-1111-1111-111111111111.sock");
  });

  it("ignores forwarded sockets owned by another user", () => {
    const readdir = vi.fn<() => ReadonlyArray<string>>(() => [
      "vscode-ssh-auth-11111111-1111-1111-1111-111111111111.sock",
    ]);
    const stat = vi.fn<(path: string) => SshAgentSocketStats>(() =>
      socketStats({ uid: 2000, mtimeMs: 10 }),
    );

    expect(
      resolveSshAuthSock({
        env: {},
        platform: "linux",
        tmpDir: "/tmp",
        currentUid: 1000,
        readdir,
        stat,
      }),
    ).toBeUndefined();
  });

  it("does not scan for POSIX sockets on Windows", () => {
    const readdir = vi.fn<() => ReadonlyArray<string>>(() => [
      "vscode-ssh-auth-11111111-1111-1111-1111-111111111111.sock",
    ]);

    expect(
      resolveSshAuthSock({
        env: {},
        platform: "win32",
        tmpDir: "/tmp",
        currentUid: 1000,
        readdir,
        stat: () => socketStats({ uid: 1000, mtimeMs: 10 }),
      }),
    ).toBeUndefined();
    expect(readdir).not.toHaveBeenCalled();
  });
});
