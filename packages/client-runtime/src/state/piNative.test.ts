import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";

import {
  EMPTY_PI_EXTERNAL_CATALOG_STATE,
  isPiExternalProjectId,
  reducePiExternalCatalog,
} from "./piNative.ts";
import { mergeExternalCatalogShells } from "./snapshots.ts";

describe("external pi catalog reducer", () => {
  it("identifies catalog-only native Pi projects", () => {
    expect(isPiExternalProjectId("external:pi-project:abc")).toBe(true);
    expect(isPiExternalProjectId("project-abc")).toBe(false);
  });

  it("replaces snapshots and marks synchronization", () => {
    const snapshot = {
      snapshotSequence: 4,
      projects: [],
      threads: [],
      omittedProjectCount: 0,
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
      projects: [],
      threads: [
        {
          id: ThreadId.make("external:pi:path:one"),
          projectId: ProjectId.make("internal-project"),
        } as never,
      ],
      omittedProjectCount: 0,
      omittedThreadCount: 0,
      updatedAt: "2026-07-30T00:00:00.000Z",
    });

    expect(merged?.threads).toEqual([]);
    expect(merged?.externalOmittedThreadCount).toBe(0);
  });
});
