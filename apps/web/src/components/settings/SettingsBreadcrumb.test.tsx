import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SettingsBreadcrumb } from "./SettingsBreadcrumb";

describe("SettingsBreadcrumb", () => {
  it.each([
    ["/settings/general", "General"],
    ["/settings/appearance", "Appearance"],
    ["/settings/keybindings", "Keybindings"],
    ["/settings/providers", "Providers"],
    ["/settings/source-control", "Source Control"],
    ["/settings/connections", "Connections"],
    ["/settings/archived", "Archive"],
    ["/settings/diagnostics", "Diagnostics"],
  ])("labels %s as %s", (pathname, label) => {
    const markup = renderToStaticMarkup(<SettingsBreadcrumb pathname={pathname} />);

    expect(markup).toContain(label);
  });

  it("renders settings as the parent of a section", () => {
    const markup = renderToStaticMarkup(<SettingsBreadcrumb pathname="/settings/source-control" />);

    expect(markup).toContain('aria-label="Settings breadcrumb"');
    expect(markup).toContain("Settings");
    expect(markup).toContain("Source Control");
    expect(markup).toContain(">/</li>");
  });

  it("renders settings as the current page at the root", () => {
    const markup = renderToStaticMarkup(<SettingsBreadcrumb pathname="/settings" />);

    expect(markup).toContain("Settings");
    expect(markup).not.toContain(">/</li>");
  });
});
