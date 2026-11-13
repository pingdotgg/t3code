// @effect-diagnostics nodeBuiltinImport:off - Exercises Git tag discovery against temporary repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { releasePackageFiles, resolveTaggedSourceVersion } from "./tagged-source-version.ts";

function makeRoot() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tagged-source-version-"));
  return {
    root,
    writeManifest: (relativePath: string, version: string) => {
      const filePath = NodePath.join(root, relativePath);
      NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
      NodeFS.writeFileSync(filePath, JSON.stringify({ version }));
    },
    git: (...args: ReadonlyArray<string>) =>
      NodeChildProcess.execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
        { cwd: root, stdio: "pipe" },
      ),
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

it("reports the single stable tag on HEAD unless a release manifest was edited", () => {
  using repo = makeRoot();
  for (const relativePath of releasePackageFiles) repo.writeManifest(relativePath, "0.1.5");
  repo.git("init", "--quiet");
  repo.git("add", ".");
  repo.git("commit", "--quiet", "--no-gpg-sign", "-m", "source");
  const resolve = () => resolveTaggedSourceVersion(repo.root, "0.1.5");

  repo.git("tag", "v0.1.6-nightly.20261031.3977");
  expect(resolve()).toBe("0.1.5");

  repo.git("tag", "--no-sign", "-a", "v0.1.6", "-m", "release");
  expect(resolve()).toBe("0.1.6");

  // A nightly or preview job on the tagged commit aligns the manifests to its own version.
  repo.writeManifest("apps/web/package.json", "0.1.7-preview.1");
  expect(resolveTaggedSourceVersion(repo.root, "0.1.7-preview.1")).toBe("0.1.7-preview.1");
  repo.writeManifest("apps/web/package.json", "0.1.5");
  expect(resolve()).toBe("0.1.6");

  repo.git("tag", "v0.1.7");
  expect(resolve()).toBe("0.1.5");

  repo.git("commit", "--quiet", "--no-gpg-sign", "--allow-empty", "-m", "after release");
  expect(resolve()).toBe("0.1.5");
});

it("keeps the manifest version in a source archive without Git metadata", () => {
  using repo = makeRoot();
  expect(resolveTaggedSourceVersion(repo.root, "0.1.5")).toBe("0.1.5");
});
