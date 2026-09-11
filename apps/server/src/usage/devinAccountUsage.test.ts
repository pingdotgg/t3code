import { describe, expect, it } from "@effect/vitest";

import { parseDevinAccountConsumptionPayload } from "./devinAccountUsage.ts";

describe("parseDevinAccountConsumptionPayload", () => {
  it("parses Devin's documented ACU response and normalizes Unix dates", () => {
    const parsed = parseDevinAccountConsumptionPayload({
      total_acus: 7.5,
      consumption_by_date: [
        {
          date: 1_756_598_400,
          acus: 5,
          acus_by_product: { devin: 4, terminal: 1 },
        },
        {
          date: "2026-08-31",
          acus: 2.5,
          acus_by_product: { cascade: 2.5, malformed: "ignored" },
        },
      ],
    });

    expect(parsed?.totalAcus).toBe(7.5);
    expect(parsed?.days).toHaveLength(2);
    expect(parsed?.days[0]).toMatchObject({
      day: "2025-08-31",
      acus: 5,
      byProduct: { devin: 4, terminal: 1 },
    });
    expect(parsed?.days[1]).toMatchObject({
      day: "2026-08-31",
      acus: 2.5,
      byProduct: { cascade: 2.5 },
    });
  });

  it("ignores malformed rows and derives a total when the response omits it", () => {
    const parsed = parseDevinAccountConsumptionPayload({
      consumption_by_date: [
        { date: "2026-08-30", acus: 1.25 },
        { date: "not-a-date", acus: 4 },
        { date: "2026-08-31", acus: -1 },
      ],
    });

    expect(parsed).toEqual({
      totalAcus: 1.25,
      days: [
        {
          day: "2026-08-30",
          acus: 1.25,
          byProduct: {},
        },
      ],
    });
  });

  it("rejects an error body or an empty unusable response", () => {
    expect(parseDevinAccountConsumptionPayload({ status: 403, detail: "forbidden" })).toBeNull();
    expect(parseDevinAccountConsumptionPayload({ consumption_by_date: [] })).toBeNull();
  });
});
