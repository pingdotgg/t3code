import { describe, expect, it } from "vitest";

import { environmentDiscoveryPresentation } from "./environmentDiscoveryPresentation";

describe("environmentDiscoveryPresentation", () => {
  it("keeps stale rows visible while presenting refresh failures", () => {
    expect(
      environmentDiscoveryPresentation({
        hasRows: true,
        isRefreshing: false,
        error: "Relay discovery timed out.",
      }),
    ).toEqual({
      showRows: true,
      showLoading: false,
      showError: true,
      showEmpty: false,
    });
  });
});
