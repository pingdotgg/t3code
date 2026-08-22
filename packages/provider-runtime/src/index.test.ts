// @effect-diagnostics nodeBuiltinImport:off - This test verifies the Promise-based Node host boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createProviderRuntime, type ProviderRuntimeKind } from "./index.ts";

describe("createProviderRuntime", () => {
  it("owns and cleans isolated state for both embedded providers", async () => {
    for (const provider of ["codex", "claude-code"] satisfies ProviderRuntimeKind[]) {
      const runtime = await createProviderRuntime({ provider });
      const stateDirectory = NodePath.resolve(runtime.attachmentsDirectory, "../..");

      await expect(runtime.listSessions()).resolves.toEqual([]);
      await expect(NodeFSP.access(stateDirectory)).resolves.toBeUndefined();

      await runtime.close();
      await runtime.close();

      await expect(NodeFSP.access(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(runtime.listSessions()).rejects.toThrow("T3 provider runtime is closed");
    }
  });
});
