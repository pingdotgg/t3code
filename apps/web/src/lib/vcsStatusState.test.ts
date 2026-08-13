import { describe, expect, it } from "vite-plus/test";

import { deserializeVcsStatusRoots, serializeVcsStatusRoots } from "./vcsStatusState";

describe("VCS status root serialization", () => {
  it("preserves repository paths containing spaces", () => {
    const roots = ["/Users/me/My Project", "/Users/me/Other Repo"];
    expect(deserializeVcsStatusRoots(serializeVcsStatusRoots(roots))).toEqual(roots);
  });
});
