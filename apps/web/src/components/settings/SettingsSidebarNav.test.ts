import { describe, expect, it } from "vite-plus/test";

import { createTranslator } from "../../i18n/messages";
import { getSettingsNavItems } from "./SettingsSidebarNav";

describe("settings navigation", () => {
  it("returns Simplified Chinese section labels", () => {
    const labels = getSettingsNavItems(createTranslator("zh-CN")).map((item) => item.label);

    expect(labels).toEqual([
      "常规",
      "外观",
      "快捷键",
      "供应商",
      "集成",
      "版本控制",
      "连接",
      "归档",
    ]);
  });
});
