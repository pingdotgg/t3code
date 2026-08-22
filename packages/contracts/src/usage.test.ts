import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { UsageDay, UsageSummaryInput } from "./usage.ts";

const LegacyUsageSummaryInput = Schema.Struct({
  sinceDay: UsageDay,
  untilDay: UsageDay,
  timeZone: Schema.String,
});
const decodeUsageSummaryInput = Schema.decodeUnknownSync(UsageSummaryInput);
const decodeLegacyUsageSummaryInput = Schema.decodeUnknownSync(LegacyUsageSummaryInput);

describe("UsageSummaryInput version negotiation", () => {
  it("accepts a legacy request with no advertised contract", () => {
    const decoded = decodeUsageSummaryInput({
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      timeZone: "UTC",
    });

    expect(decoded.contractVersion).toBeUndefined();
  });

  it("lets an old server ignore a new client's advertised contract", () => {
    const decoded = decodeLegacyUsageSummaryInput({
      contractVersion: 5,
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      timeZone: "UTC",
    });

    expect(decoded).toEqual({
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      timeZone: "UTC",
    });
  });
});
