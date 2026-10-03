import { describe, expect, it } from "vite-plus/test";

import { museApprovalChoices } from "./museProtocol.ts";

describe("Muse approval choices", () => {
  it.each([
    ["session", "acceptForSession"],
    ["localPersistent", "acceptAlways"],
    ["once", undefined],
    ["unknown", undefined],
    ["", undefined],
  ] as const)("maps policy amendments with scope %s to %s", (scope, decision) => {
    const choices = museApprovalChoices({
      availableChoices: [
        { choiceId: "choice", label: "Choice", decision: "approvedPolicyAmendment", scope },
      ],
    });
    expect([...choices.keys()]).toEqual(decision ? [decision] : []);
  });

  it("omits an unknown scope without hiding a recognized persistent choice", () => {
    const choices = museApprovalChoices({
      availableChoices: [
        {
          choiceId: "unknown",
          label: "Unknown scope",
          decision: "approvedPolicyAmendment",
          scope: "futureScope",
        },
        {
          choiceId: "persistent",
          label: "Always allow",
          decision: "approvedPolicyAmendment",
          scope: "localPersistent",
        },
      ],
    });
    expect([...choices].map(([decision, choice]) => [decision, choice.choiceId])).toEqual([
      ["acceptAlways", "persistent"],
    ]);
  });
});
