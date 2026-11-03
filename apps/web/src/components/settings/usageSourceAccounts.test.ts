import { describe, expect, it } from "vite-plus/test";

import { withAccountVisibility } from "./usageSourceAccounts";

describe("withAccountVisibility", () => {
  it("appends a newly hidden account", () => {
    expect(withAccountVisibility(["b.json", "c.json"], "a.json", false)).toEqual([
      "b.json",
      "c.json",
      "a.json",
    ]);
  });

  it("removes a shown account and keeps the others in order", () => {
    expect(withAccountVisibility(["a.json", "b.json", "c.json"], "b.json", true)).toEqual([
      "a.json",
      "c.json",
    ]);
  });

  it("leaves an already hidden account in place", () => {
    expect(withAccountVisibility(["b.json", "c.json"], "b.json", false)).toEqual([
      "b.json",
      "c.json",
    ]);
  });
});
