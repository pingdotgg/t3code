import { describe, expect, it } from "vite-plus/test";

import { chatModeRedirect, chatModeSettingsGroups } from "./settingsGroups";

describe("chat mode pages", () => {
  it.each([
    ["/pull-requests", "/"],
    ["/issues", "/"],
    ["/workflows", "/"],
    ["/settings/diffs", "/settings/general"],
    ["/settings/projects", "/settings/general"],
    ["/settings/general", null],
    ["/study", null],
    ["/", null],
  ])("%s redirects to %s", (pathname, target) => {
    expect(chatModeRedirect(pathname)).toBe(target);
  });

  it("drops a settings group with nothing left", () => {
    expect(
      chatModeSettingsGroups([
        { heading: "Code", paths: ["/settings/projects"] },
        { heading: "Preferences", paths: ["/settings/general", "/settings/diffs"] },
      ]),
    ).toEqual([{ heading: "Preferences", paths: ["/settings/general"] }]);
  });
});
