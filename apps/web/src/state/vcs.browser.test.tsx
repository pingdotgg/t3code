import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type VcsStatusResult } from "@t3tools/contracts";
import { GIT_VCS_TERMINOLOGY, JJ_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/vcs", () => ({
  createVcsEnvironmentAtoms: () => ({ status: state.status }),
  createVcsActionManager: () => ({}),
}));

import { useVcsTerminology } from "./vcs";

const gitStatus: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  pr: null,
};

it("only renders when local status terminology changes", async () => {
  const registry = AtomRegistry.make();
  const statusAtom = Atom.make(AsyncResult.success(gitStatus));
  state.status.mockReset().mockReturnValue(statusAtom);
  const environmentId = EnvironmentId.make("environment");
  let renders = 0;
  let terminology = GIT_VCS_TERMINOLOGY;
  function Probe() {
    renders += 1;
    terminology = useVcsTerminology(environmentId, "/repo");
    return null;
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  try {
    await act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <Probe />
        </RegistryContext.Provider>,
      ),
    );
    const initialRenders = renders;
    expect(terminology).toBe(GIT_VCS_TERMINOLOGY);
    expect(state.status).toHaveBeenCalledOnce();
    for (const [target] of state.status.mock.calls) {
      expect(target).toEqual({ environmentId, input: { cwd: "/repo", includeRemote: false } });
    }
    await act(() =>
      registry.set(
        statusAtom,
        AsyncResult.success({ ...gitStatus, aheadCount: 3, hasWorkingTreeChanges: true }),
      ),
    );
    expect(renders).toBe(initialRenders);
    await act(() => registry.set(statusAtom, AsyncResult.waiting(AsyncResult.success(gitStatus))));
    expect(renders).toBe(initialRenders);
    await act(() =>
      registry.set(statusAtom, AsyncResult.success({ ...gitStatus, vcs: { kind: "jj" } })),
    );
    expect(renders).toBe(initialRenders + 1);
    expect(terminology).toBe(JJ_VCS_TERMINOLOGY);
    await act(() =>
      registry.set(
        statusAtom,
        AsyncResult.success({
          ...gitStatus,
          vcs: { kind: "jj", unsupportedReason: "Unsupported workspace" },
        }),
      ),
    );
    expect(renders).toBe(initialRenders + 1);
    await act(() => registry.set(statusAtom, AsyncResult.success(gitStatus)));
    expect(renders).toBe(initialRenders + 2);
    expect(terminology).toBe(GIT_VCS_TERMINOLOGY);
  } finally {
    await act(() => root.unmount());
    registry.dispose();
    vi.unstubAllGlobals();
  }
});
