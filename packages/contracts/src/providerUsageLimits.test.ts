import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ServerProviderResetCredits } from "./providerUsageLimits.ts";

describe("ServerProviderResetCredits", () => {
  const decode = Schema.decodeUnknownSync(ServerProviderResetCredits);

  it("carries a usable-now count and a separate Fable bucket", () => {
    const credits = decode({
      availableCount: 1,
      usableNowCount: 0,
      nextCreditId: "weekly",
      fable: {
        availableCount: 2,
        nextExpiresAt: "2027-02-01T00:00:00.000Z",
        nextCreditId: "fable",
      },
    });
    expect(credits.usableNowCount).toBe(0);
    expect(credits.fable?.availableCount).toBe(2);
  });

  it("still decodes the fields older clients send", () => {
    expect(decode({ availableCount: 3 })).toEqual({ availableCount: 3 });
  });
});
