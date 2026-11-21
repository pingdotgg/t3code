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

  it("keeps the revision across a thread switch and its history loading", () => {
    expect(
      steps(start, [
        ["b", undefined],
        ["b", "b1"],
        ["c", null],
        ["a", "a1"],
      ]),
    ).toEqual(["a1", "a1", "a1", "a1"]);
  });

  it("changes on a mutation after the thread has loaded, including its first one", () => {
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
    ).toEqual(["a1", "a1", "a2", "a2"]);
  });
});
