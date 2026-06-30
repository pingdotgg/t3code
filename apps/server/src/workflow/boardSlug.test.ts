import { assert, describe, it } from "@effect/vitest";
import { slugifyBoardName, uniqueBoardSlug } from "./boardSlug.ts";

describe("boardSlug", () => {
  it("slugifies names", () => {
    assert.equal(slugifyBoardName("Workflow Board"), "workflow-board");
    assert.equal(slugifyBoardName("  A/B board!! "), "a-b-board");
    assert.equal(slugifyBoardName("!!!"), "board");
  });

  it("uniquifies against existing slugs", () => {
    const existing = new Set(["workflow-board", "workflow-board-2"]);
    assert.equal(uniqueBoardSlug("workflow-board", existing), "workflow-board-3");
    assert.equal(uniqueBoardSlug("fresh", existing), "fresh");
  });
});
