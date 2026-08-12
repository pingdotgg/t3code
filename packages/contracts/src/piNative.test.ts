import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PI_THREAD_LIFECYCLE_CUSTOM_TYPE,
  PiExternalCatalogSnapshot,
  PiThreadLifecycleCustomEntry,
} from "./piNative.ts";

describe("Pi thread lifecycle contract", () => {
  it("decodes the versioned custom JSONL entry", () => {
    expect(
      Schema.decodeUnknownSync(PiThreadLifecycleCustomEntry)({
        type: "custom",
        id: "entry-1",
        parentId: "message-1",
        timestamp: "2026-08-08T10:00:00.000Z",
        customType: PI_THREAD_LIFECYCLE_CUSTOM_TYPE,
        data: {
          version: 1,
          sessionId: "session-1",
          override: "settled",
          operationId: "operation-1",
        },
      }).data.override,
    ).toBe("settled");
  });

  it("decodes catalog snapshots from servers on either side of the project-shell removal", () => {
    const decodeSnapshot = Schema.decodeUnknownSync(PiExternalCatalogSnapshot);
    const base = {
      snapshotSequence: 1,
      threads: [],
      omittedThreadCount: 0,
      updatedAt: "2026-08-12T00:00:00.000Z",
    };

    expect(decodeSnapshot(base).omittedThreadCount).toBe(0);
    expect(
      decodeSnapshot({ ...base, projects: [], omittedProjectCount: 0 }).omittedProjectCount,
    ).toBe(0);
  });

  it("rejects unknown lifecycle versions", () => {
    expect(() =>
      Schema.decodeUnknownSync(PiThreadLifecycleCustomEntry)({
        type: "custom",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-08-08T10:00:00.000Z",
        customType: PI_THREAD_LIFECYCLE_CUSTOM_TYPE,
        data: {
          version: 2,
          sessionId: "session-1",
          override: "settled",
          operationId: "operation-1",
        },
      }),
    ).toThrow();
  });
});
