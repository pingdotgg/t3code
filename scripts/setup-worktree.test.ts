// @effect-diagnostics nodeBuiltinImport:off - Runs the real setup script against a fixture checkout.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// Windows without Developer Mode or admin rights rejects every symlink this way.
const DENY_SYMLINKS = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
fs.symlinkSync = () => {
  throw Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });
};
syncBuiltinESMExports();
`;

describe("setup-worktree", () => {
  it("copies env files when symlinks are denied and keeps the copies on later runs", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-setup-worktree-"));
    try {
      const main = NodePath.join(root, "main");
      const worktree = NodePath.join(root, "worktree");
      const bin = NodePath.join(root, "bin");
      for (const dir of [
        NodePath.join(main, "infra", "relay"),
        NodePath.join(worktree, "infra", "relay"),
        NodePath.join(worktree, "node_modules"),
        NodePath.join(worktree, "scripts"),
        bin,
      ]) {
        NodeFS.mkdirSync(dir, { recursive: true });
      }
      NodeFS.writeFileSync(NodePath.join(main, ".env"), "ROOT=1\n");
      NodeFS.writeFileSync(NodePath.join(main, "infra", "relay", ".env"), "RELAY=1\n");
      const script = NodePath.join(worktree, "scripts", "setup-worktree.ts");
      NodeFS.copyFileSync(NodePath.join(import.meta.dirname, "setup-worktree.ts"), script);
      NodeFS.writeFileSync(NodePath.join(worktree, "scripts", "package.json"), '{"type":"module"}');
      // A no-op install keeps the run on the env-file step.
      NodeFS.writeFileSync(NodePath.join(bin, "vp"), "#!/bin/sh\n", { mode: 0o755 });
      NodeFS.writeFileSync(NodePath.join(bin, "vp.cmd"), "@exit /b 0\r\n");
      NodeFS.writeFileSync(NodePath.join(worktree, "node_modules", ".modules.yaml"), "{}");

      const setup = () => {
        const run = NodeChildProcess.spawnSync(
          process.execPath,
          ["--import", `data:text/javascript,${encodeURIComponent(DENY_SYMLINKS)}`, script],
          {
            cwd: worktree,
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
              T3CODE_PROJECT_ROOT: main,
            },
          },
        );
        expect(run.status, run.stderr).toBe(0);
      };
      const envFiles = () =>
        [".env", NodePath.join("infra", "relay", ".env")].map((file) => {
          const target = NodePath.join(worktree, file);
          return {
            symlink: NodeFS.lstatSync(target).isSymbolicLink(),
            text: NodeFS.readFileSync(target, "utf8"),
          };
        });

      setup();
      expect(NodeFS.existsSync(NodePath.join(worktree, ".t3", "setup-done"))).toBe(true);
      expect(envFiles()).toEqual([
        { symlink: false, text: "ROOT=1\n" },
        { symlink: false, text: "RELAY=1\n" },
      ]);

      NodeFS.writeFileSync(NodePath.join(main, ".env"), "ROOT=2\n");
      NodeFS.writeFileSync(NodePath.join(worktree, "infra", "relay", ".env"), "LOCAL=1\n");
      setup();
      expect(envFiles()).toEqual([
        { symlink: false, text: "ROOT=1\n" },
        { symlink: false, text: "LOCAL=1\n" },
      ]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
