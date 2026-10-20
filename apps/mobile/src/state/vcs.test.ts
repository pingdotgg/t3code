import { EnvironmentId, type VcsStatusLocalResult } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import { GIT_VCS_TERMINOLOGY, JJ_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";

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
vi.mock("./atom-registry", () => ({ appAtomRegistry: { get: vi.fn() } }));

import { selectKind, selectUnsupportedReason, useVcsActionSupport, useVcsTerminology } from "./vcs";

const status: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  vcs: { kind: "jj" },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.query.mockImplementation(
    (
      atom: unknown,
      select: (result: AsyncResult.AsyncResult<VcsStatusLocalResult, unknown>) => unknown,
    ) => select(atom === null ? AsyncResult.initial(false) : AsyncResult.success(status)),
  );
});

describe("passive VCS terminology", () => {
  it("returns the shared map identity across fresh status objects", () => {
    const environmentId = EnvironmentId.make("environment");
    expect(useVcsTerminology(environmentId, "/repo")).toBe(
      useVcsTerminology(environmentId, "/repo"),
    );
  });

  it("reads local status without enabling remote polling", () => {
    const environmentId = EnvironmentId.make("environment");
    expect(useVcsTerminology(environmentId, "/repo").refNoun).toBe("bookmark");
    expect(state.status).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", includeRemote: false },
    });
  });

  it.each([
    [null, "/repo"],
    [EnvironmentId.make("environment"), null],
  ])("does not request status for an incomplete target", (environmentId, cwd) => {
    useVcsTerminology(environmentId, cwd);
    expect(state.status).not.toHaveBeenCalled();
    expect(state.query).toHaveBeenCalledWith(null, expect.any(Function));
    expect(state.fullQuery).not.toHaveBeenCalled();
  });

  it("keeps support local and exports stable kind and support selectors", () => {
    const environmentId = EnvironmentId.make("environment");
    expect(selectKind(AsyncResult.success(status))).toBe("jj");
    expect(useVcsActionSupport(environmentId, "/repo")).toMatchObject({
      supported: true,
      unsupportedReason: null,
    });
    expect(state.fullQuery).not.toHaveBeenCalled();
    for (const [target] of state.status.mock.calls) {
      expect(target).toEqual({ environmentId, input: { cwd: "/repo", includeRemote: false } });
    }
    const kindSelector = selectKind;
    const reasonSelector = state.query.mock.calls[0]?.[1];
    expect(reasonSelector).toBe(selectUnsupportedReason);
    const updatedStatus = { ...status, hasWorkingTreeChanges: true };
    expect(kindSelector(AsyncResult.success(updatedStatus))).toBe("jj");
    expect(reasonSelector(AsyncResult.success(updatedStatus))).toBeNull();
    expect(kindSelector(AsyncResult.initial())).toBeNull();
    expect(reasonSelector(AsyncResult.initial())).toBeNull();
    expect(
      reasonSelector(
        AsyncResult.success({
          ...status,
          vcs: { kind: "jj", unsupportedReason: "Unsupported workspace" },
        }),
      ),
    ).toBe("Unsupported workspace");
    useVcsActionSupport(environmentId, "/repo");
    expect(state.query.mock.calls[1]?.[1]).toBe(reasonSelector);
  });

  it("keeps shared Git terminology while an incomplete target loads", () => {
    expect(useVcsTerminology(null, "/repo")).toBe(GIT_VCS_TERMINOLOGY);
    expect(useVcsTerminology(EnvironmentId.make("environment"), "/repo")).toBe(JJ_VCS_TERMINOLOGY);
  });
});
