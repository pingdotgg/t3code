import { assert, describe, it } from "@effect/vitest";

import { isT3WorkspaceName, workspaceNameForRef } from "./JjWorkspaces.ts";

describe("workspace naming", () => {
  it("keeps bookmarks whose sanitised names collide apart", () => {
    assert.notEqual(workspaceNameForRef("a/b"), workspaceNameForRef("a-b"));
    assert.isTrue(isT3WorkspaceName(workspaceNameForRef("a/b")));
  });

  it("never claims the default workspace", () => {
    assert.isFalse(isT3WorkspaceName("default"));
  });
});
