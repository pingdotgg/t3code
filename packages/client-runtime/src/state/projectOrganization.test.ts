import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { EnvironmentProject } from "./models.ts";
import {
  nextProjectPinOrderKey,
  organizeProjectRecords,
  planProjectPinReorder,
  resolveProjectGroupOrganization,
  sortPinnedProjectsFirst,
} from "./projectOrganization.ts";

const record = (
  fields: Partial<{ pinnedAt: string; pinOrderKey: string; archivedAt: string }> = {},
) => ({
  pinnedAt: fields.pinnedAt ?? null,
  pinOrderKey: fields.pinOrderKey ?? null,
  archivedAt: fields.archivedAt ?? null,
});

describe("resolveProjectGroupOrganization", () => {
  it("keeps a project visible when its machines disagree", () => {
    expect(
      resolveProjectGroupOrganization([
        record({ pinnedAt: "2026-01-02T00:00:00.000Z", pinOrderKey: "t" }),
        record({ archivedAt: "2026-01-03T00:00:00.000Z" }),
      ]),
    ).toEqual({ pinnedAt: "2026-01-02T00:00:00.000Z", pinOrderKey: "t", archivedAt: null });
  });

  it("archives only when every record is archived, and takes the first pin slot", () => {
    expect(
      resolveProjectGroupOrganization([
        record({
          pinnedAt: "2026-01-02T00:00:00.000Z",
          pinOrderKey: "t",
          archivedAt: "2026-01-03T00:00:00.000Z",
        }),
        record({
          pinnedAt: "2026-01-01T00:00:00.000Z",
          pinOrderKey: "m",
          archivedAt: "2026-01-04T00:00:00.000Z",
        }),
      ]),
    ).toEqual({
      pinnedAt: "2026-01-01T00:00:00.000Z",
      pinOrderKey: "m",
      archivedAt: "2026-01-04T00:00:00.000Z",
    });
  });

  it("ignores the slot of an unpinned record", () => {
    expect(resolveProjectGroupOrganization([record({ pinOrderKey: "a" })])).toEqual(record());
    expect(resolveProjectGroupOrganization([])).toEqual(record());
  });
});

describe("sortPinnedProjectsFirst", () => {
  const project = (
    id: string,
    fields: Partial<{ pinnedAt: string; pinOrderKey: string }> = {},
  ) => ({
    id,
    ...record(fields),
  });

  it("moves pins to the top in slot order and keeps the rest in place", () => {
    const sorted = sortPinnedProjectsFirst([
      project("recent"),
      project("second", { pinnedAt: "2026-01-01T00:00:00.000Z", pinOrderKey: "t" }),
      project("older"),
      project("first", { pinnedAt: "2026-01-02T00:00:00.000Z", pinOrderKey: "m" }),
      project("keyless", { pinnedAt: "2026-01-04T00:00:00.000Z" }),
      project("keyless-first", { pinnedAt: "2026-01-03T00:00:00.000Z" }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual([
      "first",
      "second",
      "keyless-first",
      "keyless",
      "recent",
      "older",
    ]);
  });
});

describe("project pin slots", () => {
  it("puts a new pin after the last pinned slot", () => {
    const key = nextProjectPinOrderKey([
      record({ pinnedAt: "2026-01-01T00:00:00.000Z", pinOrderKey: "m" }),
      record({ pinOrderKey: "z" }),
    ]);
    expect(key).not.toBeNull();
    expect(key! > "m").toBe(true);
    expect(nextProjectPinOrderKey([])).not.toBeNull();
  });

  it("moves one pinned project with a single write", () => {
    const writes = planProjectPinReorder({
      orderedKeys: ["b", "a", "c"],
      pinOrderKeyByKey: new Map([
        ["a", "g"],
        ["b", "t"],
        ["c", "w"],
      ]),
      movedKey: "b",
    });
    expect(writes.map((write) => write.key)).toEqual(["b"]);
    expect(writes[0]!.pinOrderKey < "g").toBe(true);
  });
});

describe("organizeProjectRecords", () => {
  const repositoryIdentity = {
    canonicalKey: "github.com/example/shared",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/example/shared.git",
    },
  };
  const project = (
    id: string,
    environmentId: string,
    fields: Partial<EnvironmentProject> = {},
  ): EnvironmentProject => ({
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make(environmentId),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...fields,
  });
  const settings = {
    sidebarProjectGroupingMode: "repository" as const,
    sidebarProjectGroupingOverrides: {},
  };

  it("judges each record by its whole project and keeps a saved choice", () => {
    const plain = project("plain", "local");
    const archived = project("archived", "local", { archivedAt: "2026-01-02T00:00:00.000Z" });
    // Pinned on the remote machine only, so the local record leads too.
    const sharedLocal = project("shared-local", "local", { repositoryIdentity });
    const sharedRemote = project("shared-remote", "remote", {
      repositoryIdentity,
      pinnedAt: "2026-01-03T00:00:00.000Z",
      pinOrderKey: "m",
    });
    const records = [plain, archived, sharedLocal, sharedRemote];

    expect(
      organizeProjectRecords({ projects: records, settings }).map((entry) => entry.id),
    ).toEqual([sharedLocal.id, sharedRemote.id, plain.id]);
    expect(
      organizeProjectRecords({
        projects: records,
        settings,
        keep: (entry) => entry.id === archived.id,
      }).map((entry) => entry.id),
    ).toContain(archived.id);
  });
});
