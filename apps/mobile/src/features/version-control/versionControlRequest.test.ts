import { describe, expect, it, vi } from "vite-plus/test";

import {
  retryInterruptedVersionControlRequest,
  VersionControlCommandInterrupted,
} from "./versionControlRequest";

describe("native Version Control requests", () => {
  it("retries an interrupted request", async () => {
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new VersionControlCommandInterrupted())
      .mockResolvedValueOnce("loaded");

    await expect(retryInterruptedVersionControlRequest(request)).resolves.toBe("loaded");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry other failures", async () => {
    const error = new Error("failed");
    const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

    await expect(retryInterruptedVersionControlRequest(request)).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated interruption retries", async () => {
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new VersionControlCommandInterrupted());

    await expect(retryInterruptedVersionControlRequest(request)).rejects.toBeInstanceOf(
      VersionControlCommandInterrupted,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
});
