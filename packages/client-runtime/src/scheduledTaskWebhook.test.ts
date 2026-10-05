import { describe, expect, it } from "vite-plus/test";

import { parseMaxDeliveryAge } from "./scheduledTaskWebhook.ts";

describe("parseMaxDeliveryAge", () => {
  it("treats blank as no limit and rejects values the server would not accept", () => {
    expect(parseMaxDeliveryAge("")).toBeNull();
    expect(parseMaxDeliveryAge(" 45 ")).toBe(45);
    for (const invalid of ["0", "1.5", "-3", "abc", "1441"]) {
      expect(parseMaxDeliveryAge(invalid)).toBeUndefined();
    }
  });
});
