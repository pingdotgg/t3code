import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";

import { resolveWorkspaceRoot } from "./workspaceRoot";

const TEMP_DIR_PREFIX = "t3-workspace-root-test-";

describe("resolveWorkspaceRoot", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      FS.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("returns the canonical real path when the input path is a symlink", async () => {
    tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), TEMP_DIR_PREFIX));
    const canonicalWorkspaceRoot = Path.join(tempDir, "workspace");
    const symlinkWorkspaceRoot = Path.join(tempDir, "workspace-link");
    FS.mkdirSync(canonicalWorkspaceRoot, { recursive: true });
    FS.symlinkSync(canonicalWorkspaceRoot, symlinkWorkspaceRoot);

    const resolvedWorkspaceRoot = await Effect.runPromise(
      resolveWorkspaceRoot(symlinkWorkspaceRoot).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(resolvedWorkspaceRoot).toBe(FS.realpathSync(canonicalWorkspaceRoot));
  });
});
