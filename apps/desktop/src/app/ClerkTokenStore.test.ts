// @effect-diagnostics nodeBuiltinImport:off -- These tests assert real POSIX modes on a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("node:fs", { spy: true });

import { openClerkTokenStorage, type ClerkTokenStorage } from "./ClerkTokenStore.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Unix mode bits are the assertion; Windows reports them through ACLs.
const describePosix = describe.skipIf(process.platform === "win32");

const modeOf = (path: string): number => NodeFS.statSync(path).mode & 0o777;

function writeLoose(path: string, contents: string): void {
  NodeFS.writeFileSync(path, contents, { mode: 0o666 });
  NodeFS.chmodSync(path, 0o666);
}

async function withStateDir(run: (stateDir: string) => Promise<void> | void): Promise<void> {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-clerk-tokens-"));
  try {
    await run(stateDir);
  } finally {
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }
}

const idleStorage = (): ClerkTokenStorage => ({
  getItem: async () => null,
  setItem: async () => undefined,
  removeItem: () => undefined,
});

describePosix("ClerkTokenStore", () => {
  it("keeps clerk tokens at 0600 inside a 0700 directory", async () => {
    await withStateDir(async (stateDir) => {
      NodeFS.chmodSync(stateDir, 0o755);
      const directory = NodePath.join(stateDir, "clerk");
      const legacyPath = NodePath.join(stateDir, "clerk-tokens.json");
      const tokenPath = NodePath.join(directory, "clerk-tokens.json");
      NodeFS.mkdirSync(directory, { mode: 0o755 });
      NodeFS.chmodSync(directory, 0o755);
      writeLoose(legacyPath, '{"__clerk_client_jwt":"enc:existing"}\n');

      const opened: string[] = [];
      const storage = openClerkTokenStorage(stateDir, (cwd) => {
        opened.push(cwd);
        return {
          getItem: async () => {
            writeLoose(tokenPath, "from-get");
            return "from-get";
          },
          setItem: (_key, value) => {
            writeLoose(tokenPath, value);
          },
          removeItem: () => {
            NodeFS.rmSync(tokenPath, { force: true });
          },
        };
      });

      assert.deepEqual(opened, [directory]);
      assert.equal(modeOf(stateDir), 0o755);
      assert.equal(modeOf(directory), 0o700);
      assert.equal(modeOf(tokenPath), 0o600);
      assert.equal(NodeFS.existsSync(legacyPath), false);
      assert.equal(
        NodeFS.readFileSync(tokenPath, "utf8"),
        '{"__clerk_client_jwt":"enc:existing"}\n',
      );

      assert.equal(await storage.getItem("client"), "from-get");
      assert.equal(modeOf(tokenPath), 0o600);
      await storage.setItem("client", "from-set");
      assert.equal(modeOf(tokenPath), 0o600);
      assert.equal(NodeFS.readFileSync(tokenPath, "utf8"), "from-set");
      storage.removeItem("client");
      assert.equal(NodeFS.existsSync(tokenPath), false);

      writeLoose(tokenPath, "kept");
      writeLoose(legacyPath, "stale");
      NodeFS.chmodSync(directory, 0o755);
      openClerkTokenStorage(stateDir, () => idleStorage());
      assert.equal(modeOf(directory), 0o700);
      assert.equal(modeOf(tokenPath), 0o600);
      assert.equal(NodeFS.existsSync(legacyPath), false);
      assert.equal(NodeFS.readFileSync(tokenPath, "utf8"), "kept");
    });
  });

  it("removes the legacy token file when the private copy already exists", async () => {
    await withStateDir((stateDir) => {
      const directory = NodePath.join(stateDir, "clerk");
      const legacyPath = NodePath.join(stateDir, "clerk-tokens.json");
      const tokenPath = NodePath.join(directory, "clerk-tokens.json");
      NodeFS.mkdirSync(directory, { mode: 0o755 });
      writeLoose(legacyPath, "stale-credential");
      writeLoose(tokenPath, "kept-credential");

      openClerkTokenStorage(stateDir, () => idleStorage());

      assert.equal(NodeFS.existsSync(legacyPath), false);
      assert.equal(modeOf(directory), 0o700);
      assert.equal(modeOf(tokenPath), 0o600);
      assert.equal(NodeFS.readFileSync(tokenPath, "utf8"), "kept-credential");
    });
  });

  it("resolves a relative state directory before opening storage", async () => {
    await withStateDir(async (stateDir) => {
      const relativeStateDir = NodePath.relative(process.cwd(), stateDir);
      const opened: string[] = [];
      openClerkTokenStorage(relativeStateDir, (directory) => {
        opened.push(directory);
        return idleStorage();
      });

      const directory = NodePath.join(stateDir, "clerk");
      assert.equal(NodePath.isAbsolute(relativeStateDir), false);
      assert.deepEqual(opened, [directory]);
      assert.equal(modeOf(directory), 0o700);
    });
  });

  it("migrates relative state paths from Electron userData, not the working directory", async () => {
    await withStateDir((stateDir) => {
      const relativeStateDir = NodePath.relative(process.cwd(), stateDir);
      const userData = NodePath.join(
        stateDir,
        "electron",
        ...relativeStateDir.split(NodePath.sep).map(() => "profile"),
      );
      const legacyStateDir = NodePath.join(userData, relativeStateDir);
      const legacyPath = NodePath.join(legacyStateDir, "clerk-tokens.json");
      NodeFS.mkdirSync(legacyStateDir, { recursive: true });
      writeLoose(legacyPath, "existing-session");
      const unrelatedPath = NodePath.join(stateDir, "clerk-tokens.json");
      writeLoose(unrelatedPath, "not-the-electron-session");

      openClerkTokenStorage(relativeStateDir, idleStorage, userData);

      const tokenPath = NodePath.join(stateDir, "clerk", "clerk-tokens.json");
      assert.equal(NodeFS.readFileSync(tokenPath, "utf8"), "existing-session");
      assert.equal(modeOf(tokenPath), 0o600);
      assert.equal(NodeFS.existsSync(legacyPath), false);
      assert.equal(NodeFS.readFileSync(unrelatedPath, "utf8"), "not-the-electron-session");
    });
  });

  it("migrates tokens when the legacy directory is on another filesystem", async () => {
    await withStateDir((stateDir) => {
      const legacyPath = NodePath.join(stateDir, "clerk-tokens.json");
      writeLoose(legacyPath, "existing-session");
      using _rename = vi.spyOn(NodeFS, "renameSync").mockImplementation(() => {
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      });

      openClerkTokenStorage(stateDir, idleStorage);

      const tokenPath = NodePath.join(stateDir, "clerk", "clerk-tokens.json");
      assert.equal(NodeFS.readFileSync(tokenPath, "utf8"), "existing-session");
      assert.equal(modeOf(tokenPath), 0o600);
      assert.equal(NodeFS.existsSync(legacyPath), false);
    });
  });

  it("does not follow a symlinked clerk directory or token file", async () => {
    await withStateDir(async (stateDir) => {
      const outsideDirectory = NodePath.join(stateDir, "outside-dir");
      NodeFS.mkdirSync(outsideDirectory, { mode: 0o755 });
      NodeFS.chmodSync(outsideDirectory, 0o755);
      NodeFS.symlinkSync(outsideDirectory, NodePath.join(stateDir, "clerk"));

      assert.throws(() => openClerkTokenStorage(stateDir, idleStorage), /must be a real directory/);
      assert.equal(modeOf(outsideDirectory), 0o755);
      NodeFS.unlinkSync(NodePath.join(stateDir, "clerk"));

      const outsideFile = NodePath.join(stateDir, "outside.json");
      NodeFS.writeFileSync(outsideFile, "secret", { mode: 0o644 });
      NodeFS.chmodSync(outsideFile, 0o644);
      NodeFS.symlinkSync(outsideFile, NodePath.join(stateDir, "clerk-tokens.json"));
      assert.throws(() => openClerkTokenStorage(stateDir, idleStorage), /must be a regular file/);
      assert.equal(modeOf(outsideFile), 0o644);
    });
  });
});
