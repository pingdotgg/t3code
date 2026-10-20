import { EnvironmentId, type VcsStatusResult } from "@t3tools/contracts";
import { GIT_VCS_TERMINOLOGY, JJ_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: vi.fn((input: unknown) => input),
  query: vi.fn(),
  fullQuery: vi.fn(),
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/vcs", () => ({
  createVcsEnvironmentAtoms: () => ({ status: state.status }),
  createVcsActionManager: () => ({}),
}));
vi.mock("./query", () => ({
  useEnvironmentQuerySelector: state.query,
  useEnvironmentQuery: state.fullQuery,
}));

import { useVcsTerminology } from "./vcs";

const status: VcsStatusResult = {
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
  vcs: { kind: "jj" },
};
beforeEach(() => {
  vi.clearAllMocks();
  state.fullQuery.mockReturnValue({ data: status });
  state.query.mockImplementation(
    (
      _atom: unknown,
      select: (result: AsyncResult.AsyncResult<VcsStatusResult, unknown>) => unknown,
    ) => select(AsyncResult.success(status)),
  );
});

describe("passive VCS terminology", () => {
  it("reads local status through a stable terminology selector", () => {
    const environmentId = EnvironmentId.make("environment");
    expect(useVcsTerminology(environmentId, "/repo")).toBe(JJ_VCS_TERMINOLOGY);
    expect(state.query).toHaveBeenCalledOnce();
    expect(state.fullQuery).not.toHaveBeenCalled();
    expect(state.status).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", includeRemote: false },
    });
    const selector = state.query.mock.calls[0]?.[1];
    useVcsTerminology(environmentId, "/repo");
    expect(state.query.mock.calls[1]?.[1]).toBe(selector);
    expect(selector(AsyncResult.success({ ...status, aheadCount: 3 }))).toBe(JJ_VCS_TERMINOLOGY);
    expect(selector(AsyncResult.initial())).toBe(GIT_VCS_TERMINOLOGY);
  });

  it.each([
    [null, "/repo"],
    [EnvironmentId.make("environment"), null],
  ])("does not request status for an incomplete target", (environmentId, cwd) => {
    useVcsTerminology(environmentId, cwd);
    expect(state.status).not.toHaveBeenCalled();
    expect(state.query).toHaveBeenCalledWith(null, expect.any(Function));
  });
});
