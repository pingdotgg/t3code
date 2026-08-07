import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

import { sanitizePreferences } from "./mobile-preferences";

describe("sanitizePreferences completed-PR auto-settle", () => {
  it("drops an absent preference so resolvers can default on", () => {
    expect(sanitizePreferences({}).autoSettleCompletedChangeRequests).toBeUndefined();
  });

  it.each([true, false])("keeps an explicit completed-PR auto-settle choice: %s", (value) => {
    expect(
      sanitizePreferences({
        autoSettleCompletedChangeRequests: value,
        threadListV2Enabled: true,
      }),
    ).toEqual({
      autoSettleCompletedChangeRequests: value,
      threadListV2Enabled: true,
    });
  });

  it("ignores non-boolean completed-PR auto-settle values", () => {
    expect(
      sanitizePreferences({
        autoSettleCompletedChangeRequests: "yes" as unknown as boolean,
      }).autoSettleCompletedChangeRequests,
    ).toBeUndefined();
  });
});
