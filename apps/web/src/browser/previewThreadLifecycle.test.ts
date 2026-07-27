import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectRemovedPreviewThreadRefs } from "./previewThreadLifecycle";

const activeRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-active"));
const archivedRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-archived"));
const deletedRef = scopeThreadRef("env-2" as EnvironmentId, ThreadId.make("thread-deleted"));

describe("collectRemovedPreviewThreadRefs", () => {
  it("finds archived and deleted preview state across an authoritative shell transition", () => {
    expect(
      collectRemovedPreviewThreadRefs({
        previousActiveThreadRefs: [activeRef, archivedRef, deletedRef],
        activeThreadRefs: [activeRef],
      }),
    ).toEqual([archivedRef, deletedRef]);
  });

  it("cleans removed threads after preview sessions close first", () => {
    expect(
      collectRemovedPreviewThreadRefs({
        previousActiveThreadRefs: [archivedRef],
        activeThreadRefs: [],
      }),
    ).toEqual([archivedRef]);
  });
});
