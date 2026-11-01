// @effect-diagnostics nodeBuiltinImport:off - Exercises build-time Git discovery against temporary repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

import { resolveTaggedSourceVersion } from "./tagged-source-version.ts";

it("uses the exact stable tag, preserving release overrides and untagged builds", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tagged-source-version-"));
  const manifest = NodePath.join(root, "apps/server/package.json");
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const writeVersion = (version: string) =>
    NodeFS.writeFileSync(manifest, JSON.stringify({ name: "t3", version }));

  try {
    NodeFS.mkdirSync(NodePath.dirname(manifest), { recursive: true });
    writeVersion("0.1.5");
    git("init");
    git("config", "user.name", "Version Test");
    git("config", "user.email", "version@example.com");
    git("config", "commit.gpgSign", "false");
    git("config", "tag.gpgSign", "false");
    git("add", ".");
    git("commit", "-m", "source");
    git("tag", "v0.1.6-nightly.20261031.3977");
    git("tag", "-a", "v0.1.6", "-m", "release");

    expect(resolveTaggedSourceVersion(root, "0.1.5")).toBe("0.1.6");
    expect(JSON.parse(NodeFS.readFileSync(manifest, "utf8")).version).toBe("0.1.5");

    writeVersion("0.1.7-preview.1");
    expect(resolveTaggedSourceVersion(root, "0.1.7-preview.1")).toBe("0.1.7-preview.1");

    writeVersion("0.1.5");
    git("commit", "--allow-empty", "-m", "after release");
    expect(resolveTaggedSourceVersion(root, "0.1.5")).toBe("0.1.5");

    git("tag", "not-a-release");
    expect(resolveTaggedSourceVersion(root, "0.1.5")).toBe("0.1.5");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps the package version in a source archive without Git metadata", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "source-archive-version-"));
  try {
    expect(resolveTaggedSourceVersion(root, "0.1.5")).toBe("0.1.5");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
