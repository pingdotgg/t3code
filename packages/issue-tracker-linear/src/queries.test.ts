import { assert, describe, it } from "@effect/vitest";

import { ISSUE_DETAIL_QUERY, ISSUES_QUERY, VIEW_ISSUES_QUERY } from "./queries.ts";

describe("relation page sizes", () => {
  // Linear rejects a 50-issue saved-view page as "too complex" past 20 relations per direction
  // (measured: 10 → 4,736 points, 20 → 8,436, 25 → rejected), while a plain list stays near 400.
  it("keeps saved views small, reads full blocker pages in lists and outgoing edges in detail only", () => {
    assert.include(VIEW_ISSUES_QUERY, "inverseRelations(first: 10)");
    assert.include(ISSUES_QUERY, "inverseRelations(first: 50)");
    assert.notInclude(ISSUES_QUERY, "relations(first:");
    assert.notInclude(VIEW_ISSUES_QUERY, "relations(first:");
    assert.include(ISSUE_DETAIL_QUERY, "relations(first: 50)");
    assert.include(ISSUE_DETAIL_QUERY, "inverseRelations(first: 50)");
  });
});
