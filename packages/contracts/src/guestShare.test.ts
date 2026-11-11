import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { GuestRedeemRequest } from "./guestShare.ts";

const isRedeem = Schema.is(GuestRedeemRequest);

describe("GuestRedeemRequest", () => {
  it("accepts a one-line name and rejects names that break the attribution line", () => {
    expect(isRedeem({ credential: "invite", name: "Maya Chen" })).toBe(true);
    for (const name of [
      "Maya\nowner",
      "Maya owner",
      "Maya owner",
      "Maya\u0007",
      "Theo\u202E (owner)",
      "Theo\u2066x",
    ]) {
      expect(isRedeem({ credential: "invite", name })).toBe(false);
    }
  });
});
