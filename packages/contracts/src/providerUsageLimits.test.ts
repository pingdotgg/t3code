import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ServerProviderResetCredits } from "./providerUsageLimits.ts";

describe("ServerProviderResetCredits", () => {
  const decode = Schema.decodeUnknownSync(ServerProviderResetCredits);

  it("carries a usable-now count and a separate Fable option", () => {
    const credits = decode({
      availableCount: 1,
      usableNowCount: 0,
      nextCreditId: "weekly",
      options: [
        {
          creditId: "fable",
          label: "Fable reset",
          description: "Refills your Fable allowance.",
          availableCount: 2,
          expiresAt: "2027-02-01T00:00:00.000Z",
        },
      ],
    });
    expect(credits.usableNowCount).toBe(0);
    expect(credits.options?.[0]?.availableCount).toBe(2);
  });

  it("still decodes the fields older clients send", () => {
    expect(decode({ availableCount: 3 })).toEqual({ availableCount: 3 });
  });
});
