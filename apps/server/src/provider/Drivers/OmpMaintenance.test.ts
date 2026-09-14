import type { ServerProviderWorkspaceSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendOmpWorkspaceSnapshot,
  OMP_MAX_WORKSPACE_SNAPSHOTS,
  parseOmpUpdateCheck,
} from "./OmpMaintenance.ts";
describe("parseOmpUpdateCheck", () => {
  it("reads current and latest versions from an update-available check", () => {
    expect(
      parseOmpUpdateCheck("Current version: 18.1.18\nNew version available: 18.1.21\n"),
    ).toEqual({ currentVersion: "18.1.18", latestVersion: "18.1.21" });
  });

  it("leaves latest empty when omp reports itself current", () => {
    expect(parseOmpUpdateCheck("Current version: 18.1.21\nAlready up to date.\n")).toEqual({
      currentVersion: "18.1.21",
      latestVersion: null,
    });
  });

  it("returns nulls when the output carries no version", () => {
    expect(parseOmpUpdateCheck("checking for updates...\nfailed: network unreachable\n")).toEqual({
      currentVersion: null,
      latestVersion: null,
    });
  });
});

describe("appendOmpWorkspaceSnapshot", () => {
  const entry = (cwd: string) => ({
    cwd,
    checkedAt: "2026-09-14T00:00:00.000Z",
    slashCommands: [],
    skills: [],
  });

  it("records the first workspace", () => {
    const next = appendOmpWorkspaceSnapshot([], entry("/work/a"));
    expect(next.map((snapshot) => snapshot.cwd)).toEqual(["/work/a"]);
  });

  it("keeps earlier workspaces and replaces a revisited cwd instead of duplicating it", () => {
    const first = appendOmpWorkspaceSnapshot([], entry("/work/a"));
    const second = appendOmpWorkspaceSnapshot(first, entry("/work/b"));
    expect(second.map((snapshot) => snapshot.cwd)).toEqual(["/work/a", "/work/b"]);
    const third = appendOmpWorkspaceSnapshot(second, {
      ...entry("/work/a"),
      checkedAt: "2026-09-14T01:00:00.000Z",
    });
    expect(third.map((snapshot) => snapshot.cwd)).toEqual(["/work/b", "/work/a"]);
    expect(third).toHaveLength(2);
  });

  it(`evicts the least recently recorded workspace past ${OMP_MAX_WORKSPACE_SNAPSHOTS}`, () => {
    let snapshots: ReadonlyArray<ServerProviderWorkspaceSnapshot> = [];
    for (let index = 0; index < OMP_MAX_WORKSPACE_SNAPSHOTS + 2; index += 1) {
      snapshots = appendOmpWorkspaceSnapshot(snapshots, entry(`/work/${index}`));
    }
    expect(snapshots).toHaveLength(OMP_MAX_WORKSPACE_SNAPSHOTS);
    expect(snapshots[0]?.cwd).toBe("/work/2");
    expect(snapshots.at(-1)?.cwd).toBe(`/work/${OMP_MAX_WORKSPACE_SNAPSHOTS + 1}`);
  });
});
