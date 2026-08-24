import { describe, expect, it } from "vite-plus/test";
import { createTranslator } from "../../i18n";
import { THEME_COLOR_ROLES } from "../../themePalette";
import { getThemeRoleLabel } from "./ThemeColorPicker";

describe("getThemeRoleLabel", () => {
  it("preserves the existing English fallback labels without a translator", () => {
    expect(getThemeRoleLabel("canvas")).toBe("Background");
    expect(getThemeRoleLabel("toolbarForeground")).toBe("Toolbar text");
    expect(getThemeRoleLabel("surfaceRaised")).toBe("Surface Raised");
    expect(getThemeRoleLabel("terminalScrollbarHover")).toBe("Terminal Scrollbar Hover");
  });

  it("keeps the English catalog aligned with every fallback label", () => {
    const t = createTranslator("en");

    for (const role of THEME_COLOR_ROLES) {
      expect(getThemeRoleLabel(role, t)).toBe(getThemeRoleLabel(role));
    }
  });

  it("localizes role labels for the theme editor", () => {
    const t = createTranslator("zh-CN");

    expect(getThemeRoleLabel("canvas", t)).toBe("背景");
    expect(getThemeRoleLabel("chrome", t)).toBe("应用框架");
    expect(getThemeRoleLabel("toolbarForeground", t)).toBe("工具栏文字");
    expect(getThemeRoleLabel("surfaceRaised", t)).toBe("浮层表面");
    expect(getThemeRoleLabel("terminalScrollbarHover", t)).toBe("终端滚动条悬停");
  });
});
