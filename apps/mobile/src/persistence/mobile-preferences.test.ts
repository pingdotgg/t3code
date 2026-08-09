import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

import { sanitizePreferences } from "./mobile-preferences";

describe("sanitizePreferences", () => {
  it("preserves a completed-PR auto-settle choice", () => {
    expect(sanitizePreferences({ autoSettleCompletedChangeRequests: false })).toEqual({
      autoSettleCompletedChangeRequests: false,
    });
  });

  it("drops a malformed completed-PR auto-settle choice", () => {
    expect(sanitizePreferences({ autoSettleCompletedChangeRequests: "no" } as never)).toEqual({});
  });
});
