import { describe, expect, it } from "vite-plus/test";
import { PROJECT_ICON_NAMES, selectProjectIcon } from "./projectIconModel";

describe("selectProjectIcon", () => {
  it.each([
    ["customer-api", "server"],
    ["AnalyticsDatabase", "database"],
    ["ios-client", "mobile"],
    ["terraform-infra", "cloud"],
    ["developer-docs", "book"],
    ["shop-frontend", "shopping"],
    ["agent-runtime", "ai"],
    ["video-studio", "video"],
  ] as const)("classifies %s as %s", (projectName, expectedIcon) => {
    expect(selectProjectIcon(projectName, `/workspace/${projectName}`).icon).toBe(expectedIcon);
  });

  it("uses the workspace directory when the project name is blank", () => {
    expect(selectProjectIcon("", "C:\\work\\mobile-app").icon).toBe("mobile");
  });

  it("uses Lucide icons for automatic project icons", () => {
    expect(selectProjectIcon("agent-runtime", "/workspace/agent-runtime")).toEqual({
      kind: "lucide",
      icon: "ai",
    });
  });

  it("gives unknown names a stable generic icon", () => {
    const icon = selectProjectIcon("mercury", "/workspace/mercury");

    expect(icon.kind).toBe("lucide");
    expect(PROJECT_ICON_NAMES).toContain(icon.icon);
    expect(selectProjectIcon("mercury", "/elsewhere/mercury")).toEqual(icon);
  });
});
