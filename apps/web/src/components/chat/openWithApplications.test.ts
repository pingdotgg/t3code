import type { CustomEditor, CustomEditorId, InstalledApplication } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  customEditorIdFor,
  filterApplications,
  forgetApplication,
  rememberApplication,
} from "./openWithApplications";

const app = (
  id: string,
  name: string,
  command: string,
  args: ReadonlyArray<string> = [],
): InstalledApplication => ({ id, name, command, args });

const entry = (id: string, label: string, command: string): CustomEditor => ({
  id: id as CustomEditorId,
  label,
  command,
  args: [],
});

describe("filterApplications", () => {
  const applications = [
    app("brave-web-browser", "Brave Web Browser", "/usr/bin/brave"),
    app("android-studio", "Android Studio", "/opt/android-studio/bin/studio.sh"),
  ];

  it("returns everything for an empty query", () => {
    expect(filterApplications(applications, "   ")).toHaveLength(2);
  });

  it("matches case-insensitively anywhere in the name", () => {
    expect(filterApplications(applications, "STUDIO").map((a) => a.id)).toEqual(["android-studio"]);
  });

  it("returns nothing when no name matches", () => {
    expect(filterApplications(applications, "emacs")).toEqual([]);
  });
});

describe("customEditorIdFor", () => {
  it("prefixes the discovered id", () => {
    expect(customEditorIdFor(app("zed", "Zed", "/usr/bin/zed"))).toBe("custom:zed");
  });
});

describe("rememberApplication", () => {
  it("appends a picked application", () => {
    const next = rememberApplication([], app("zed", "Zed", "/usr/bin/zed", ["--wait"]));
    expect(next).toEqual([
      { id: "custom:zed", label: "Zed", command: "/usr/bin/zed", args: ["--wait"] },
    ]);
  });

  it("refreshes an existing entry in place rather than duplicating it", () => {
    const existing = [entry("custom:zed", "Zed", "/old/zed")];
    const next = rememberApplication(existing, app("zed", "Zed", "/new/zed"));
    expect(next).toHaveLength(1);
    expect(next[0]?.command).toBe("/new/zed");
  });

  it("preserves unrelated entries and their order", () => {
    const existing = [entry("custom:a", "A", "/a"), entry("custom:zed", "Zed", "/old/zed")];
    const next = rememberApplication(existing, app("zed", "Zed", "/new/zed"));
    expect(next.map((item) => item.id)).toEqual(["custom:a", "custom:zed"]);
  });

  it("truncates a name longer than the schema allows", () => {
    const longName = "x".repeat(100);
    const next = rememberApplication([], app("long", longName, "/bin/long"));
    expect(next[0]?.label).toHaveLength(64);
  });
});

describe("forgetApplication", () => {
  it("drops only the named entry", () => {
    const existing = [entry("custom:a", "A", "/a"), entry("custom:b", "B", "/b")];
    expect(forgetApplication(existing, "custom:a" as CustomEditorId).map((i) => i.id)).toEqual([
      "custom:b",
    ]);
  });
});
