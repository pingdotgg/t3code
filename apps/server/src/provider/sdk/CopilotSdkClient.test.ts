// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { resolveCopilotBinaryPath } from "./CopilotSdkClient.ts";

// A name that can't exist in the machine's real PATH / common install dirs, so
// these tests only see the executables they create and don't pick up a
// brew/npm-installed `copilot`.
const BIN = "copilot-resolver-test-bin";

async function makeExecutable(dir: string, name: string): Promise<string> {
  const filePath = NodePath.join(dir, name);
  await NodeFSP.writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  await NodeFSP.chmod(filePath, 0o755);
  return filePath;
}

describe("resolveCopilotBinaryPath", () => {
  it("returns an explicit path (containing a separator) verbatim", async () => {
    const explicit = NodePath.join("/opt", "custom", BIN);
    const resolved = await resolveCopilotBinaryPath(explicit, {});
    assert.strictEqual(resolved, explicit);
  });

  it("resolves a bare name against the spawn env PATH", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-resolve-"));
    const expected = await makeExecutable(dir, BIN);
    const resolved = await resolveCopilotBinaryPath(BIN, { PATH: dir });
    assert.strictEqual(resolved, expected);
  });

  it("skips a directory named like the binary and resolves a real file later in PATH", async () => {
    const shadowDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-shadow-"));
    const realDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-real-"));
    // A directory named like the binary earlier in PATH must not shadow the CLI.
    await NodeFSP.mkdir(NodePath.join(shadowDir, BIN));
    const expected = await makeExecutable(realDir, BIN);
    const resolved = await resolveCopilotBinaryPath(BIN, {
      PATH: `${shadowDir}${NodePath.delimiter}${realDir}`,
    });
    assert.strictEqual(resolved, expected);
  });

  it("falls back to the bare name when nothing resolves", async () => {
    const emptyDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-empty-"));
    const resolved = await resolveCopilotBinaryPath(BIN, { PATH: emptyDir });
    assert.strictEqual(resolved, BIN);
  });
});
