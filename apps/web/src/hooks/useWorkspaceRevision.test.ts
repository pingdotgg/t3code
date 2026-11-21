import { describe, expect, it } from "vite-plus/test";

import { advanceWorkspaceRevision, type WorkspaceRevisionState } from "./useWorkspaceRevision";

const steps = (
  initial: WorkspaceRevisionState,
  inputs: ReadonlyArray<readonly [string, string | null | undefined]>,
) => {
  let state = initial;
  return inputs.map(([scope, mutationId]) => {
    state = advanceWorkspaceRevision(state, scope, mutationId);
    return state.revision;
  });
};

describe("advanceWorkspaceRevision", () => {
  const start: WorkspaceRevisionState = {
    scope: "a",
    seen: new Map([["a", "a1"]]),
    revision: "a1",
  };

  it("keeps the revision across thread switches whose mutation ids have not moved", () => {
    expect(
      steps(
        {
          scope: "a",
          seen: new Map([
            ["a", "a1"],
            ["b", "b1"],
          ]),
          revision: "a1",
        },
        [
          ["b", undefined],
          ["b", "b1"],
          ["a", "a1"],
        ],
      ),
    ).toEqual(["a1", "a1", "a1"]);
  });

  it("changes on a never-viewed thread's first mutation id, but not on one with none", () => {
    expect(
      steps(start, [
        ["b", undefined],
        ["b", "b1"],
        ["a", "a1"],
        ["c", null],
      ]),
    ).toEqual(["a1", "b1", "b1", "b1"]);
  });

  it("changes on a mutation after the thread has loaded", () => {
    expect(
      steps(start, [
        ["b", undefined],
        ["b", null],
        ["b", "b1"],
        ["b", "b2"],
        ["a", "a1"],
        ["a", "a2"],
      ]),
    ).toEqual(["a1", "a1", "b1", "b2", "b2", "a2"]);
  });

  it("changes on returning to a thread whose mutation id moved while it was not viewed", () => {
    expect(
      steps(start, [
        ["b", "b1"],
        ["a", undefined],
        ["a", "a2"],
        ["b", "b1"],
      ]),
    ).toEqual(["b1", "b1", "a2", "a2"]);
  });
});
