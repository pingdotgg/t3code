import { beforeEach, describe, expect, it, vi } from "@effect/vitest";

import {
  getSettingsBackTargetHref,
  navigateToSettingsBackTarget,
  rememberSettingsBackTarget,
  resetSettingsBackTargetForTests,
} from "./settingsNavigation";

describe("settings navigation", () => {
  beforeEach(() => {
    resetSettingsBackTargetForTests();
  });

  it("remembers the latest non-settings route as the settings back target", () => {
    rememberSettingsBackTarget({
      href: "/environment-local/thread-1?panel=diff",
      pathname: "/environment-local/thread-1",
    });
    rememberSettingsBackTarget({
      href: "/settings/general",
      pathname: "/settings/general",
    });

    expect(getSettingsBackTargetHref()).toBe("/environment-local/thread-1?panel=diff");
  });

  it("navigates to the remembered route through router history", () => {
    const push = vi.fn();
    rememberSettingsBackTarget({
      href: "/draft/draft-1",
      pathname: "/draft/draft-1",
    });

    navigateToSettingsBackTarget({ push });

    expect(push).toHaveBeenCalledWith("/draft/draft-1");
  });
});
