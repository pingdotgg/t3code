import { describe, expect, it } from "vite-plus/test";

import { splitWorkEntryPathTokens } from "./TimelineWorkEntryRow.logic";

describe("splitWorkEntryPathTokens", () => {
  it("isolates workspace-relative, prefixed, and absolute paths without matching prose slashes", () => {
    expect(splitWorkEntryPathTokens("עריכת src/שלום/index.ts")).toEqual([
      { text: "עריכת ", isPath: false },
      { text: "src/שלום/index.ts", isPath: true },
    ]);

    expect(splitWorkEntryPathTokens("קריאה ב-src/index.ts וב-/etc/hosts")).toEqual([
      { text: "קריאה ב-", isPath: false },
      { text: "src/index.ts", isPath: true },
      { text: " וב-", isPath: false },
      { text: "/etc/hosts", isPath: true },
    ]);

    expect(splitWorkEntryPathTokens("בדיקה כן/לא וגם and/or")).toEqual([
      { text: "בדיקה כן/לא וגם and/or", isPath: false },
    ]);
  });
});
