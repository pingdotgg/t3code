import { describe, expect, it } from "@effect/vitest";

import { relayHyperdriveOriginConnectionLimit } from "./db.ts";

describe("relay Hyperdrive configuration", () => {
  it("keeps enough origin connections for concurrent relay request fan-out", () => {
    expect(relayHyperdriveOriginConnectionLimit).toBeGreaterThanOrEqual(20);
  });
});
