import { describe, expect, it } from "vite-plus/test";

import { referralClaimMessage } from "./referralClaimResult";

describe("referralClaimMessage", () => {
  it("describes every claim outcome and uses the server award", () => {
    expect(referralClaimMessage("claimed", 100)).toMatchObject({
      type: "success",
      description: expect.stringContaining("100 points"),
    });
    expect(referralClaimMessage("already_claimed").type).toBe("info");
    expect(referralClaimMessage("invalid_code").type).toBe("warning");
    expect(referralClaimMessage("self_referral").title).toContain("account chain");
    expect(referralClaimMessage("ineligible").description).toContain("before linking");
  });
});
