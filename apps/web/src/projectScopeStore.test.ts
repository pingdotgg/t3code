import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useProjectScopeStore } from "./projectScopeStore.ts";

beforeEach(() => {
  useProjectScopeStore.setState({ projectScopeKey: null });
});

describe("projectScopeStore", () => {
  it("owns one nullable project scope for every surface", () => {
    useProjectScopeStore.getState().setProjectScopeKey("logical:alpha");
    expect(useProjectScopeStore.getState().projectScopeKey).toBe("logical:alpha");

    useProjectScopeStore.getState().setProjectScopeKey(null);
    expect(useProjectScopeStore.getState().projectScopeKey).toBeNull();
  });
});
