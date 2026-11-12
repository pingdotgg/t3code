import { PROJECT_TRACKED_FOLDERS_MAX, type WorkspaceScannedFolder } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendTrackedFolders,
  trackedFoldersFromSelection,
  untrackedScannedFolders,
} from "./projectTrackedFolders.ts";

const scanned = (name: string, path = `/work/${name}`): WorkspaceScannedFolder => ({
  path,
  name,
  isGitRepository: true,
  source: "child",
});

describe("untrackedScannedFolders", () => {
  it("offers only folders the project does not track, once each", () => {
    expect(
      untrackedScannedFolders(
        [{ path: "/work/api", name: "API" }],
        [scanned("api"), scanned("web"), scanned("web"), scanned("docs")],
      ).map((folder) => folder.name),
    ).toEqual(["web", "docs"]);
  });
});

describe("trackedFoldersFromSelection", () => {
  it("selects every scanned folder until one is deselected", () => {
    const folders = [scanned("api"), scanned("web")];
    expect(trackedFoldersFromSelection(folders, new Set())).toEqual([
      { path: "/work/api", name: "api" },
      { path: "/work/web", name: "web" },
    ]);
    expect(trackedFoldersFromSelection(folders, new Set(["/work/api"]))).toEqual([
      { path: "/work/web", name: "web" },
    ]);
  });

  it("shortens a name the project schema would reject", () => {
    const [folder] = trackedFoldersFromSelection(
      [scanned("n".repeat(200), "/work/long")],
      new Set(),
    );
    expect(folder?.name).toHaveLength(128);
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
