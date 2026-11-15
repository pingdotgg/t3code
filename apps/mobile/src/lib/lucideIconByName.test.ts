import { icons } from "lucide";
import { describe, expect, it } from "vite-plus/test";

import { LUCIDE_SHAPE_TAGS, lucideIconByName } from "./lucideIconByName";

describe("lucideIconByName", () => {
  it("resolves picker names and deprecated aliases, and falls back to folder-code", () => {
    expect(lucideIconByName("snowflake")).toBe(icons.Snowflake);
    expect(lucideIconByName("gamepad-2")).toBe(icons.Gamepad2);
    expect(lucideIconByName("alert-circle")).toBe(icons.CircleAlert);
    expect(lucideIconByName("not-a-lucide-icon")).toBe(icons.FolderCode);
    expect(lucideIconByName("__proto__")).toBe(icons.FolderCode);
  });

  it("draws every shape Lucide ships", () => {
    const tags = new Set(Object.values(icons).flatMap((node) => node.map(([tag]) => tag)));
    expect([...tags].sort()).toEqual([...LUCIDE_SHAPE_TAGS]);
  });
});
