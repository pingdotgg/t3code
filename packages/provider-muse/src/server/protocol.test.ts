import { describe, expect, it } from "vite-plus/test";

import { museApprovalChoices } from "./protocol.ts";

// Muse 1.4.3 shell approvals offer only `abort`; the muse_permission replay covers that case.
describe("Muse approval choices", () => {
  it("keeps denied and abort separate when Muse offers both", () => {
    const choices = museApprovalChoices({
      availableChoices: [
        { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
        { choiceId: "abort", label: "Stop", decision: "abort", scope: "once" },
      ],
    });
    expect(choices.get("decline")?.choiceId).toBe("deny");
    expect(choices.get("cancel")?.choiceId).toBe("abort");
  });
});
