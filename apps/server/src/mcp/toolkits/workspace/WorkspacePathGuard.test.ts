import { describe, expect, it } from "@effect/vitest";

import {
  describeRejection,
  isBlockedPath,
  isContainedWithin,
  resolveWithin,
} from "./WorkspacePathGuard.ts";

const root = "/workspace/repo";

describe("isContainedWithin", () => {
  it("accepts the root itself and paths beneath it", () => {
    expect(isContainedWithin(root, root)).toBe(true);
    expect(isContainedWithin(root, `${root}/src/index.ts`)).toBe(true);
    expect(isContainedWithin(root, `${root}/a/b/c`)).toBe(true);
  });

  it("rejects a sibling directory that shares the root's name prefix", () => {
    // The classic string-prefix escape: `/workspace/repo-secrets` starts with
    // `/workspace/repo`, so a `startsWith` check would let it through.
    expect(isContainedWithin(root, "/workspace/repo-secrets")).toBe(false);
    expect(isContainedWithin(root, "/workspace/repo-secrets/.env")).toBe(false);
  });

  it("rejects parents and unrelated trees", () => {
    expect(isContainedWithin(root, "/workspace")).toBe(false);
    expect(isContainedWithin(root, "/etc/passwd")).toBe(false);
  });
});

describe("resolveWithin", () => {
  it("resolves a relative path and reports it relative to the root", () => {
    const result = resolveWithin({ root, requestedPath: "src/index.ts" });
    expect(result).toEqual({
      ok: true,
      absolutePath: `${root}/src/index.ts`,
      relativePath: "src/index.ts",
    });
  });

  it("normalises the root itself to '.'", () => {
    const result = resolveWithin({ root, requestedPath: "." });
    expect(result.ok && result.relativePath).toBe(".");
  });

  it("refuses traversal out of the workspace", () => {
    const result = resolveWithin({ root, requestedPath: "../../etc/passwd" });
    expect(result).toEqual({ ok: false, rejection: "escapes-workspace" });
  });

  it("refuses an absolute path outside the workspace instead of rebasing it", () => {
    // Joining would have quietly produced `<root>/etc/passwd` and read a file
    // the caller did not ask for.
    const result = resolveWithin({ root, requestedPath: "/etc/passwd" });
    expect(result).toEqual({ ok: false, rejection: "escapes-workspace" });
  });

  it("accepts an absolute path that is genuinely inside the workspace", () => {
    const result = resolveWithin({ root, requestedPath: `${root}/src/main.ts` });
    expect(result.ok && result.relativePath).toBe("src/main.ts");
  });

  it("refuses a contained path whose realpath escapes through a symlink", () => {
    const result = resolveWithin({
      root,
      requestedPath: "link-to-secrets",
      realPath: "/etc/secrets",
    });
    expect(result).toEqual({ ok: false, rejection: "symlink-escapes-workspace" });
  });

  it("accepts a symlink that stays inside the workspace", () => {
    const result = resolveWithin({
      root,
      requestedPath: "link",
      realPath: `${root}/src/real.ts`,
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ".git/config",
    "node_modules/left-pad/index.js",
    ".env",
    ".env.production",
    "config/service.pem",
    "keys/id_rsa",
    "deploy/id_ed25519.pub",
    ".ssh/known_hosts",
    "secrets/credentials.json",
    "nested/deep/.git/HEAD",
  ])("refuses blocked path %s", (path) => {
    expect(isBlockedPath(path)).toBe(true);
    expect(resolveWithin({ root, requestedPath: path })).toEqual({
      ok: false,
      rejection: "blocked-path",
    });
  });

  it.each([
    "src/index.ts",
    "README.md",
    "docs/environment.md",
    "packages/contracts/src/settings.ts",
    "apps/server/keychain.ts",
  ])("allows ordinary source path %s", (path) => {
    expect(isBlockedPath(path)).toBe(false);
    expect(resolveWithin({ root, requestedPath: path }).ok).toBe(true);
  });

  it("does not confuse a filename that merely contains a blocked word", () => {
    // `environment.md` contains "env" and `keychain.ts` contains "key", but
    // neither is a credential file. Over-blocking makes the bridge useless on
    // real repositories, so the matchers are anchored, not substring-based.
    expect(isBlockedPath("docs/environment.md")).toBe(false);
    expect(isBlockedPath("src/monkey.ts")).toBe(false);
    expect(isBlockedPath("src/.environment")).toBe(false);
  });
});

describe("describeRejection", () => {
  it("explains every rejection without leaking the resolved path", () => {
    for (const rejection of [
      "escapes-workspace",
      "symlink-escapes-workspace",
      "blocked-path",
    ] as const) {
      const message = describeRejection(rejection);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("/");
    }
  });
});
