import { describe, expect, it } from "vite-plus/test";

import { issuesSearchFromUrl } from "./issuesSearch.logic";

describe("issuesSearchFromUrl", () => {
  it("replaces a malformed label or order instead of letting the raw value through", () => {
    // The router lays the validated keys over the raw search, so a key left out keeps its raw value.
    const raw = { label: true, order: "oldest", assignee: "   " };
    const search = { ...raw, ...issuesSearchFromUrl(raw) };
    expect(search.label).toBeUndefined();
    expect(search.assignee).toBeUndefined();
    expect(search.order).toBeUndefined();
    expect(issuesSearchFromUrl({ label: "bug" }).label).toEqual(["bug"]);
    expect(issuesSearchFromUrl({ label: ["bug", " ui "], order: "created" })).toMatchObject({
      label: ["bug", "ui"],
      order: "created",
    });
  });
});
