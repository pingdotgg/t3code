import { assert, describe, it } from "@effect/vitest";

import { ISSUES_QUERY, VIEW_ISSUES_QUERY } from "./queries.ts";

describe("relation page sizes", () => {
  // Linear rejects a 50-issue saved-view page as "too complex" once relations pass 20 per direction
  // (measured: 10 → 4,736 points, 25 → rejected), while the plain list stays near 400 at 50.
  it("keeps saved views small and reads full relation pages elsewhere", () => {
    assert.include(VIEW_ISSUES_QUERY, "relations(first: 10)");
    assert.include(VIEW_ISSUES_QUERY, "inverseRelations(first: 10)");
    assert.include(ISSUES_QUERY, "relations(first: 50)");
    assert.include(ISSUES_QUERY, "inverseRelations(first: 50)");
  });
});
