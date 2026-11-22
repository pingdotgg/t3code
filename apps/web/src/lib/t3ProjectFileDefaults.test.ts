import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  query: null as Atom.Atom<unknown> | null,
}));

vi.mock("~/rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return testState.registry;
  },
}));

vi.mock("~/components/files/projectFilesQueryState", () => ({
  getProjectFileQueryAtom: () => testState.query,
  resolveProjectFileQueryData: (
    _environmentId: EnvironmentId,
    _cwd: string,
    _relativePath: string,
    data: ProjectReadFileResult | null,
  ) => data,
}));

import { readT3ProjectFile } from "./t3ProjectFileDefaults";

describe("readT3ProjectFile", () => {
  it("refreshes a mounted query once it ages past the stale threshold", async () => {
    const registry = AtomRegistry.make();
    let callCount = 0;
    let contents = '{"defaultThreadEnvMode":"local"}';
    const query = Atom.make(
      Effect.sync<ProjectReadFileResult>(() => {
        callCount += 1;
        return {
          relativePath: "t3.json",
          contents,
          byteLength: contents.length,
          truncated: false,
        };
      }),
    );
    testState.registry = registry;
    testState.query = query;

    let now = Date.parse("2026-01-02T00:00:00.000Z");
    using _clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const unmount = registry.mount(query);
    try {
      const initial = await readT3ProjectFile(EnvironmentId.make("env-1"), "/repo");
      expect(initial?.defaultThreadEnvMode).toBe("local");
      expect(callCount).toBe(1);

      // Update the file on disk and advance past the 30 s stale threshold while still mounted.
      contents = '{"defaultThreadEnvMode":"worktree"}';
      now += 31_000;

      const refreshed = await readT3ProjectFile(EnvironmentId.make("env-1"), "/repo");
      expect(refreshed?.defaultThreadEnvMode).toBe("worktree");
      expect(callCount).toBe(2);
    } finally {
      unmount();
    }
  });

  it("retries a mounted query that previously settled in Failure", async () => {
    const registry = AtomRegistry.make();
    let callCount = 0;
    let shouldFail = true;
    const query = Atom.make(
      Effect.suspend(() => {
        callCount += 1;
        if (shouldFail) {
          return Effect.fail({ _tag: "TransientReadFailure" as const });
        }
        const contents = '{"defaultThreadEnvMode":"worktree"}';
        const result: ProjectReadFileResult = {
          relativePath: "t3.json",
          contents,
          byteLength: contents.length,
          truncated: false,
        };
        return Effect.succeed(result);
      }),
    );
    testState.registry = registry;
    testState.query = query;

    const unmount = registry.mount(query);
    try {
      // Sidebar prefetch runs on mount and settles in Failure.
      await vi.waitFor(() => expect(registry.get(query)._tag).toBe("Failure"));
      expect(callCount).toBe(1);

      shouldFail = false;
      const retried = await readT3ProjectFile(EnvironmentId.make("env-1"), "/repo");
      expect(retried?.defaultThreadEnvMode).toBe("worktree");
      expect(callCount).toBe(2);
    } finally {
      unmount();
    }
  });
});
