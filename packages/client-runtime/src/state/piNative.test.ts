import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";

import { EMPTY_PI_EXTERNAL_CATALOG_STATE, reducePiExternalCatalog } from "./piNative.ts";
import { mergeExternalCatalogShells } from "./snapshots.ts";

describe("external pi catalog reducer", () => {
  it("replaces snapshots and marks synchronization", () => {
    const snapshot = {
      snapshotSequence: 4,
      threads: [],
      omittedThreadCount: 0,
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    const loaded = reducePiExternalCatalog(EMPTY_PI_EXTERNAL_CATALOG_STATE, {
      kind: "snapshot",
      snapshot,
    });

    expect(loaded).toEqual({ snapshot, synchronized: false });
    expect(reducePiExternalCatalog(loaded, { kind: "synchronized" })).toEqual({
      snapshot,
      synchronized: true,
    });
  });

  it("omits external threads until their associated project shell exists", () => {
    const merged = mergeExternalCatalogShells(null, {
      snapshotSequence: 1,
      threads: [
        {
          id: ThreadId.make("external:pi:path:one"),
          projectId: ProjectId.make("internal-project"),
        } as never,
      ],
      omittedThreadCount: 0,
      updatedAt: "2026-07-30T00:00:00.000Z",
    });

    expect(merged?.threads).toEqual([]);
    expect(merged?.externalOmittedThreadCount).toBe(0);
  });

  it("keeps external threads whose project the user added", () => {
    const projectId = ProjectId.make("internal-project");
    const merged = mergeExternalCatalogShells(
      {
        snapshotSequence: 2,
        projects: [{ id: projectId, workspaceRoot: "/home/dev/app" } as never],
        threads: [],
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
      {
        snapshotSequence: 1,
        threads: [{ id: ThreadId.make("external:pi:path:one"), projectId } as never],
        omittedThreadCount: 3,
        updatedAt: "2026-07-30T00:00:01.000Z",
      },
    );

    expect(merged?.threads.map((thread) => thread.id)).toEqual(["external:pi:path:one"]);
    expect(merged?.projects).toHaveLength(1);
    expect(merged?.externalOmittedThreadCount).toBe(3);
  });
});
