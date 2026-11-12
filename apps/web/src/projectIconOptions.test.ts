import { AlarmClockCheck, ArrowDown01, Layers3 } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";
import { lucideIconByName } from "./lib/lucideIconByName";
import {
  filterProjectIconNames,
  firstEmoji,
  MAX_ICON_RESULTS,
  PROJECT_ICON_CATEGORIES,
} from "./projectIconOptions";

describe("projectIconOptions", () => {
  it.each(PROJECT_ICON_CATEGORIES.flatMap((category) => category.icons))(
    "resolves suggested icon %s",
    (name) => expect(lucideIconByName(name)).toBeDefined(),
  );

  it("resolves saved legacy spellings", () => {
    expect(lucideIconByName("layers-3")).toBe(Layers3);
    expect(lucideIconByName("arrow-down-01")).toBe(ArrowDown01);
    expect(lucideIconByName("arrow-down-0-1")).toBe(ArrowDown01);
    expect(lucideIconByName("alarm-check")).toBe(AlarmClockCheck);
    expect(lucideIconByName("create-lucide-icon")).toBeUndefined();
  });

  it("searches the whole set by name parts and keywords, capped", () => {
    expect(filterProjectIconNames("git pull")[0]).toBe("git-pull-request");
    expect(filterProjectIconNames("review")).toContain("eye");
    expect(filterProjectIconNames("a").length).toBe(MAX_ICON_RESULTS);
    for (const name of filterProjectIconNames("cal")) expect(lucideIconByName(name)).toBeDefined();
    expect(filterProjectIconNames("zzqx")).toEqual([]);
  });

  it("extracts one complete emoji grapheme", () => {
    expect(firstEmoji("  👩🏽‍💻 hello")).toBe("👩🏽‍💻");
    expect(firstEmoji("🇺🇸 project")).toBe("🇺🇸");
    expect(firstEmoji("1️⃣ project")).toBe("1️⃣");
    expect(firstEmoji("plain text")).toBeNull();
    expect(firstEmoji("👨‍👩‍👧‍👦".repeat(2))).toBe("👨‍👩‍👧‍👦");
  });
});
