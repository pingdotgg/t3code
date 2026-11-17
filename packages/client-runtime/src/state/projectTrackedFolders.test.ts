import { PROJECT_TRACKED_FOLDERS_MAX, type WorkspaceScannedFolder } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { appendTrackedFolders, suggestedTrackedFolders } from "./projectTrackedFolders.ts";

const scanned = (name: string, path = `/work/${name}`): WorkspaceScannedFolder => ({
  path,
  name,
  isGitRepository: true,
  source: "child",
});

describe("suggestedTrackedFolders", () => {
  it("offers what a workspace file lists and the project does not cover, once each", () => {
    const listed = (name: string) => ({ ...scanned(name), source: "code-workspace" as const });
    expect(
      suggestedTrackedFolders(
        [{ path: "/work/api", name: "API", discovered: true }],
        [listed("api"), listed("lib"), listed("lib"), scanned("web"), listed("x".repeat(200))],
      ),
    ).toEqual([
      { path: "/work/lib", name: "lib" },
      { path: `/work/${"x".repeat(200)}`, name: "x".repeat(128) },
    ]);
  });
});

describe("appendTrackedFolders", () => {
  it("keeps tracked folders a scan did not return and skips ones already tracked", () => {
    expect(
      appendTrackedFolders(
        [
          { path: "/elsewhere/tools", name: "tools" },
          { path: "/work/api", name: "API" },
        ],
        [
          { path: "/work/api", name: "api" },
          { path: "/work/web", name: "web" },
        ],
      ),
    ).toEqual([
      { path: "/elsewhere/tools", name: "tools" },
      { path: "/work/api", name: "API" },
      { path: "/work/web", name: "web" },
    ]);
  });

  it("refuses a list longer than the server accepts", () => {
    const tracked = Array.from({ length: PROJECT_TRACKED_FOLDERS_MAX }, (_, index) => ({
      path: `/work/${index}`,
      name: `${index}`,
    }));
    expect(appendTrackedFolders(tracked, [{ path: "/work/0", name: "0" }])).toEqual(tracked);
    expect(appendTrackedFolders(tracked, [{ path: "/work/extra", name: "extra" }])).toBeNull();
  });
});
