import { describe, expect, it } from "vite-plus/test";

import {
  breadcrumbPathOf,
  fileBreadcrumbChildren,
  fileBreadcrumbParent,
  fileBreadcrumbs,
  isListableHostFolder,
  joinHostPath,
  retainedBreadcrumbTrail,
  trailChildOf,
} from "./filePath";

describe("fileBreadcrumbs", () => {
  it("builds project, directory, and file crumbs", () => {
    expect(fileBreadcrumbs("t3code", "apps/web/src/main.tsx")).toEqual([
      { label: "t3code", path: "", kind: "project" },
      { label: "apps", path: "apps", kind: "directory" },
      { label: "web", path: "apps/web", kind: "directory" },
      { label: "src", path: "apps/web/src", kind: "directory" },
      { label: "main.tsx", path: "apps/web/src/main.tsx", kind: "file" },
    ]);
  });

  it("normalizes repeated separators", () => {
    expect(fileBreadcrumbs("workspace", "src//index.ts").map((crumb) => crumb.label)).toEqual([
      "workspace",
      "src",
      "index.ts",
    ]);
  });

  it("starts host paths outside the workspace at the filesystem root", () => {
    expect(fileBreadcrumbs("t3code", "/tmp/t3-cleanup/report.md")).toEqual([
      { label: "tmp", path: "/tmp", kind: "directory" },
      { label: "t3-cleanup", path: "/tmp/t3-cleanup", kind: "directory" },
      { label: "report.md", path: "/tmp/t3-cleanup/report.md", kind: "file" },
    ]);
    expect(fileBreadcrumbs("t3code", "C:\\Temp\\report.md")).toEqual([
      { label: "C:", path: "C:\\", kind: "directory" },
      { label: "Temp", path: "C:\\Temp", kind: "directory" },
      { label: "report.md", path: "C:\\Temp\\report.md", kind: "file" },
    ]);
    expect(fileBreadcrumbs("t3code", "\\\\server\\share\\report.md").map((c) => c.path)).toEqual([
      "\\\\server",
      "\\\\server\\share",
      "\\\\server\\share\\report.md",
    ]);
  });
});

describe("breadcrumbPathOf", () => {
  it.each([
    ["", ""],
    ["src", "src"],
    ["src/", "src"],
    ["src//components", "src/components"],
    ["/tmp/t3-demo/", "/tmp/t3-demo"],
    ["/", "/"],
    ["C:\\Users\\me\\", "C:\\Users\\me"],
    ["C:\\", "C:\\"],
    ["\\\\server\\share\\", "\\\\server\\share"],
  ])("writes %j as its crumb names it", (path, expected) => {
    expect(breadcrumbPathOf(path)).toBe(expected);
  });
});

describe("fileBreadcrumbChildren", () => {
  const entries = [
    { path: "README.md", kind: "file" as const },
    { path: "src", kind: "directory" as const },
    { path: "src-old", kind: "directory" as const },
    { path: "src/index.ts", kind: "file" as const },
    { path: "src/lib", kind: "directory" as const },
    { path: "src/lib/file10.ts", kind: "file" as const },
    { path: "src/lib/file2.ts", kind: "file" as const },
    { path: "src-old/index.ts", kind: "file" as const },
  ];

  it("returns only the immediate children of the project root", () => {
    expect(fileBreadcrumbChildren(entries, "")).toEqual([
      { path: "src", kind: "directory", label: "src" },
      { path: "src-old", kind: "directory", label: "src-old" },
      { path: "README.md", kind: "file", label: "README.md" },
    ]);
  });

  it("honors segment boundaries and sorts folders before files", () => {
    expect(fileBreadcrumbChildren(entries, "src")).toEqual([
      { path: "src/lib", kind: "directory", label: "lib" },
      { path: "src/index.ts", kind: "file", label: "index.ts" },
    ]);
  });

  it("uses natural file-name ordering and preserves input order for equivalent names", () => {
    const files = ["file10.ts", "File2.ts", "file02.ts", "file2.ts"].map((name) => ({
      path: `src/lib/${name}`,
      kind: "file" as const,
    }));

    expect(fileBreadcrumbChildren(files, "src/lib").map((entry) => entry.label)).toEqual([
      "File2.ts",
      "file02.ts",
      "file2.ts",
      "file10.ts",
    ]);
  });

  it("returns an empty list for an empty or missing directory", () => {
    expect(fileBreadcrumbChildren(entries, "missing")).toEqual([]);
  });
});

describe("retainedBreadcrumbTrail", () => {
  it.each([
    // Walking up keeps the deeper path, all the way to the workspace root.
    ["apps/web/src", "apps/web", "apps/web/src"],
    ["apps/web/src", "", "apps/web/src"],
    // Walking back down inside the trail keeps it too.
    ["apps/web/src", "apps/web/src", "apps/web/src"],
    // Somewhere else starts over, including a sibling that shares a name prefix.
    ["apps/web/src", "apps/mobile", "apps/mobile"],
    ["src/lib", "src-old", "src-old"],
    ["apps/web", "apps/web/src/main.tsx", "apps/web/src/main.tsx"],
    // Workspace and host paths never share a trail.
    ["apps/web/src", "/tmp/report", "/tmp/report"],
    ["/tmp/report", "", ""],
    ["C:\\Temp\\a", "", ""],
    // Host folders outside the workspace keep their trail the same way.
    ["/Users/me/projects/scope", "/Users/me", "/Users/me/projects/scope"],
    ["/Users/me/projects/scope", "/Users/me/proj", "/Users/me/proj"],
    ["/Volumes/Work/a", "/Volumes/Work/a/", "/Volumes/Work/a"],
    ["C:\\Users\\me\\scope", "C:\\", "C:\\Users\\me\\scope"],
    ["C:\\Users\\me\\scope", "C:\\Users", "C:\\Users\\me\\scope"],
    ["C:\\Users\\me\\scope", "D:\\", "D:\\"],
    ["\\\\nas\\share\\docs\\notes", "\\\\nas\\share", "\\\\nas\\share\\docs\\notes"],
  ])("from trail %j to %j keeps %j", (trail, path, expected) => {
    expect(retainedBreadcrumbTrail(trail, path)).toBe(expected);
  });

  it("starts at the path when nothing came before", () => {
    expect(retainedBreadcrumbTrail(undefined, "apps")).toBe("apps");
  });
});

describe("trailChildOf", () => {
  it.each([
    ["/Users/me", "/Users/me/projects/scope", "projects"],
    ["/Users/me/projects/scope", "/Users/me/projects/scope", null],
    ["/Users/me", "/Users/meg/a", null],
    ["C:\\", "C:\\Users\\me", "Users"],
    ["C:\\Users", "C:\\Users\\me\\scope", "me"],
    ["\\\\nas\\share", "\\\\nas\\share\\docs\\notes", "docs"],
  ])("in %j toward %j selects %j", (folder, trail, expected) => {
    expect(trailChildOf(folder, trail)).toBe(expected);
  });
});

describe("joinHostPath", () => {
  it.each([
    ["/Users/me", "projects/scope", "/Users/me/projects/scope"],
    ["/", "Users", "/Users"],
    ["C:\\", "Users/me", "C:\\Users\\me"],
    ["C:\\Users", "me", "C:\\Users\\me"],
    ["\\\\nas\\share", "docs/notes.md", "\\\\nas\\share\\docs\\notes.md"],
  ])("joins %j and %j as %j", (folder, relativePath, expected) => {
    expect(joinHostPath(folder, relativePath)).toBe(expected);
  });
});

describe("isListableHostFolder", () => {
  it.each([
    ["/Users", true],
    ["C:\\", true],
    ["\\\\nas\\share", true],
    // A UNC server is not a directory the server can list.
    ["\\\\nas", false],
    ["apps/web", false],
  ])("%j is %j", (path, expected) => {
    expect(isListableHostFolder(path)).toBe(expected);
  });
});

describe("fileBreadcrumbParent", () => {
  it.each([
    ["src/lib", "src"],
    ["src", ""],
    ["", null],
  ])("returns the parent of %j", (path, expected) => {
    expect(fileBreadcrumbParent(path)).toBe(expected);
  });
});
