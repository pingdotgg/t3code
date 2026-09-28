import { describe, expect, it } from "vitest";

import {
  getLastWsStreamActivityMs,
  recordWsStreamActivity,
  resetWsStreamActivityForTests,
} from "./wsActivity";

describe("wsActivity", () => {
  it("records stream activity and resets for tests", () => {
    resetWsStreamActivityForTests(1_000);
    expect(getLastWsStreamActivityMs()).toBe(1_000);

    recordWsStreamActivity(2_000);
    expect(getLastWsStreamActivityMs()).toBe(2_000);

    recordWsStreamActivity(Number.NaN);
    expect(getLastWsStreamActivityMs()).toBe(2_000);
  });
});
