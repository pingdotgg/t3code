import type { IssueDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { issueWriteAccess } from "./issuePresentation.ts";

describe("issueWriteAccess", () => {
  it("does not offer the category an issue is already in under a workflow name", () => {
    const detail = {
      writable: true,
      state: { category: "open", name: "Todo" },
      capabilities: {
        states: [
          { category: "open", name: "open" },
          { category: "closed", name: "closed" },
        ],
      },
      viewerPermissions: { setState: true },
    } as unknown as IssueDetail;
    expect(issueWriteAccess(detail, true).states).toEqual([{ category: "closed", name: "closed" }]);
  });
});
