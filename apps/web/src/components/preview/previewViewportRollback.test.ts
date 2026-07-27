import { describe, expect, it } from "vite-plus/test";

import { shouldRollbackPreviewViewport } from "./previewViewportRollback";

describe("shouldRollbackPreviewViewport", () => {
  const fill = { _tag: "fill" } as const;
  const requested = { _tag: "freeform", width: 900, height: 600 } as const;

  it("rolls back a timed-out request that still owns the latest setting", () => {
    expect(shouldRollbackPreviewViewport(fill, requested, requested)).toBe(true);
  });

  it("does not overwrite a newer resize or repeat an identical setting", () => {
    expect(
      shouldRollbackPreviewViewport(fill, requested, {
        _tag: "freeform",
        width: 1024,
        height: 768,
      }),
    ).toBe(false);
    expect(shouldRollbackPreviewViewport(requested, requested, requested)).toBe(false);
  });
});
