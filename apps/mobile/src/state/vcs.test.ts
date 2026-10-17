import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: vi.fn((input: unknown) => input),
  query: vi.fn(() => ({ data: { vcs: { kind: "jj" } } })),
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/vcs", () => ({
  createVcsEnvironmentAtoms: () => ({ status: state.status }),
  createVcsActionManager: () => ({}),
}));
vi.mock("./query", () => ({ useEnvironmentQuery: state.query }));

import { useVcsTerminology } from "./vcs";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("passive VCS terminology", () => {
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
    expect(state.query).toHaveBeenCalledWith(null);
  });
});
