import type { InstalledApplication } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { customEditorIdFor, filterApplications } from "./openWithApplications";

const app = (id: string, name: string): InstalledApplication => ({
  id,
  name,
  command: "/usr/bin/app",
  args: [],
});

describe("filterApplications", () => {
  const applications = [
    app("brave-web-browser", "Brave Web Browser"),
    app("android-studio", "Android Studio"),
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
  // Must match the id the server derives when it writes the entry, or the list
  // would never show an application as already remembered.
  it("prefixes the discovered id", () => {
    expect(customEditorIdFor(app("zed", "Zed"))).toBe("custom:zed");
  });
});
