import { describe, expect, it } from "vite-plus/test";

import {
  beginPreviewViewportMutation,
  shouldRollbackPreviewViewport,
} from "./previewViewportRollback";

describe("shouldRollbackPreviewViewport", () => {
  const fill = { _tag: "fill" } as const;
  const requested = { _tag: "freeform", width: 900, height: 600 } as const;

  it("rolls back a timed-out request that still owns the latest setting", () => {
    const mutation = beginPreviewViewportMutation("runtime-tab");
    expect(
      shouldRollbackPreviewViewport(
        "runtime-tab",
        mutation,
        fill,
        requested,
        requested,
        "server-a",
        "server-a",
      ),
    ).toBe(true);
  });

  it("does not overwrite a newer resize, replacement server, or repeated setting", () => {
    const mutation = beginPreviewViewportMutation("runtime-tab");
    expect(
      shouldRollbackPreviewViewport(
        "runtime-tab",
        mutation,
        fill,
        requested,
        {
          _tag: "freeform",
          width: 1024,
          height: 768,
        },
        "server-a",
        "server-a",
      ),
    ).toBe(false);
    expect(
      shouldRollbackPreviewViewport(
        "runtime-tab",
        mutation,
        fill,
        requested,
        requested,
        "server-a",
        "server-b",
      ),
    ).toBe(false);
    expect(
      shouldRollbackPreviewViewport(
        "runtime-tab",
        mutation,
        requested,
        requested,
        requested,
        "server-a",
        "server-a",
      ),
    ).toBe(false);
  });

  it("does not roll back a timed-out resize after a concurrent same-value resize", () => {
    const firstMutation = beginPreviewViewportMutation("runtime-tab");
    beginPreviewViewportMutation("runtime-tab");

    expect(
      shouldRollbackPreviewViewport(
        "runtime-tab",
        firstMutation,
        fill,
        requested,
        requested,
        "server-a",
        "server-a",
      ),
    ).toBe(false);
  });
});
