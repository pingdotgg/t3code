import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { isPreviewPartition, previewPartitionForEnvironment } from "./preview.ts";

describe("preview browser partitions", () => {
  it("derives and recognizes only non-empty preview partitions", () => {
    const partition = previewPartitionForEnvironment(EnvironmentId.make("env-local"));

    expect(partition).toBe("persist:t3-preview-env-local");
    expect(isPreviewPartition(partition)).toBe(true);
    expect(isPreviewPartition("persist:t3-preview-")).toBe(false);
    expect(isPreviewPartition("persist:other-env-local")).toBe(false);
  });
});
