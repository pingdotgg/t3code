import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

vi.mock("~/components/files/projectFilesQueryState", () => ({
  getProjectFileQueryAtom: vi.fn(),
  resolveProjectFileQueryData: (
    _environmentId: unknown,
    _cwd: string,
    _relativePath: string,
    data: ProjectReadFileResult | null,
  ) => data,
}));

import { getProjectFileQueryAtom } from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readT3ProjectFileDefaultThreadEnvMode } from "./t3ProjectFileDefaults";

afterEach(() => {
  vi.restoreAllMocks();
  appAtomRegistry.reset();
});

describe("readT3ProjectFileDefaultThreadEnvMode", () => {
  it("falls back when a file query stays pending past its deadline", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    vi.mocked(getProjectFileQueryAtom).mockReturnValue(Atom.make(Effect.never));

    const pending = readT3ProjectFileDefaultThreadEnvMode(
      EnvironmentId.make("remote"),
      "/remote/project",
    );
    // Fire the deadline deterministically; executeAtomQuery still uses the
    // real registry and interruptible query wait.
    deadline.abort();

    await expect(pending).resolves.toBeNull();
    expect(AbortSignal.timeout).toHaveBeenCalledWith(3_000);
  });

  it("honors t3.json defaults when the file query succeeds", async () => {
    vi.mocked(getProjectFileQueryAtom).mockReturnValue(
      Atom.make(
        Effect.succeed({
          contents: '{"defaultThreadEnvMode":"worktree"}',
          truncated: false,
        } as ProjectReadFileResult),
      ),
    );

    await expect(
      readT3ProjectFileDefaultThreadEnvMode(EnvironmentId.make("local"), "/local/project"),
    ).resolves.toBe("worktree");
  });
});
