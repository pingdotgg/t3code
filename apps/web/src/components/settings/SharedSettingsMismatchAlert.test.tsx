import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import type { SharedSettingsMismatch } from "@t3tools/client-runtime/state/shared-settings";

const state = vi.hoisted(() => ({
  mismatches: [] as SharedSettingsMismatch[],
  sourceLabel: "Desktop",
  applyToAll: vi.fn(),
}));

vi.mock("../../hooks/useSettings", () => ({ useSharedSettingsSync: () => state }));

import { SharedSettingsMismatchAlert } from "./SharedSettingsMismatchAlert";

describe("SharedSettingsMismatchAlert", () => {
  it("shows no warning when environments agree", () => {
    state.mismatches = [];
    expect(renderToStaticMarkup(<SharedSettingsMismatchAlert />)).toBe("");
  });

  it("names the source and differing values inside the review", () => {
    state.mismatches = [
      {
        environmentId: EnvironmentId.make("remote"),
        label: "Remote laptop",
        differences: [{ key: "sidebarAutoSettleAfterDays", currentValue: 3, incomingValue: null }],
      },
    ];
    const markup = renderToStaticMarkup(<SharedSettingsMismatchAlert />);
    const review = markup.slice(markup.indexOf("<details"), markup.indexOf("</details>"));
    expect(review).toContain("Review differences");
    expect(review).toContain("Remote laptop");
    expect(review).toContain("From Desktop");
    expect(review).toContain("After 3 days");
    expect(review).toContain("Off");
    expect(review).toContain("Apply to all");
  });
});
