import { AlarmClockCheck, ArrowDown01, Layers3 } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";
import { lucideIconByName } from "./lib/lucideIconByName";
import {
  filterProjectIconNames,
  firstEmoji,
  projectIconColorClassName,
} from "./projectIconOptions";

describe("projectIconOptions", () => {
  it("searches across the full Lucide set", () => {
    expect(filterProjectIconNames("alarm clock")).toContain("alarm-clock");
    expect(filterProjectIconNames("alarm  \tclock")).toContain("alarm-clock");
  });

  it("resolves every offered icon name, including saved legacy spellings", () => {
    for (const name of filterProjectIconNames("")) expect(lucideIconByName(name)).toBeDefined();
    expect(lucideIconByName("layers-3")).toBe(Layers3);
    expect(lucideIconByName("arrow-down-01")).toBe(ArrowDown01);
    expect(lucideIconByName("arrow-down-0-1")).toBe(ArrowDown01);
    expect(lucideIconByName("alarm-check")).toBe(AlarmClockCheck);
    expect(lucideIconByName("create-lucide-icon")).toBeUndefined();
  });

  it("extracts one complete emoji grapheme", () => {
    expect(firstEmoji("  👩🏽‍💻 hello")).toBe("👩🏽‍💻");
    expect(firstEmoji("🇺🇸 project")).toBe("🇺🇸");
    expect(firstEmoji("1️⃣ project")).toBe("1️⃣");
    expect(firstEmoji("plain text")).toBeNull();
  });

  it("maps persisted colors to theme-aware classes", () => {
    expect(projectIconColorClassName("violet")).toBe("text-violet-600 dark:text-violet-400");
  });
});
