import { USAGE_CONTRACT_VERSION, USAGE_MERGE_COMPATIBLE_SINCE } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { compatibleUsageSources } from "./usageProviders";

describe("Usage provider sources", () => {
  it("only retains sources whose contract versions can contribute to merged totals", () => {
    const sources = compatibleUsageSources([
      { summary: { contractVersion: USAGE_CONTRACT_VERSION, sources: ["current"] } },
      { summary: { contractVersion: USAGE_MERGE_COMPATIBLE_SINCE, sources: ["older"] } },
      { summary: { contractVersion: USAGE_MERGE_COMPATIBLE_SINCE - 1, sources: ["too-old"] } },
      { summary: { contractVersion: USAGE_CONTRACT_VERSION + 1, sources: ["too-new"] } },
      { summary: null },
    ]);
    expect(sources).toEqual(["current", "older"]);
  });
});
