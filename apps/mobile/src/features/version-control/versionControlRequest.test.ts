import { describe, expect, it, vi } from "vite-plus/test";

import {
  retainPullRefreshIndicator,
  retryInterruptedVersionControlRequest,
  runInitialRemoteFetch,
  VERSION_CONTROL_CHECKOUT_ACTION_OPTIONS,
  VersionControlCommandInterrupted,
} from "./versionControlRequest";

describe("native Version Control requests", () => {
  it("retains pull-to-refresh feedback when a background refresh supersedes it", () => {
    expect(retainPullRefreshIndicator(false, true)).toBe(true);
    expect(retainPullRefreshIndicator(true, false)).toBe(true);
    expect(retainPullRefreshIndicator(false, false)).toBe(false);
  });

  it("keeps checkout failures local to the Version Control mutation surface", () => {
    expect(VERSION_CONTROL_CHECKOUT_ACTION_OPTIONS).toEqual({
      reportFailure: false,
      throwOnFailure: true,
    });
  });

  it("releases a failed initial remote fetch so focus can retry it", async () => {
    const fetchedCwds = new Set<string>();
    const fetch = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("offline"));
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue();

    await expect(
      runInitialRemoteFetch({ cwd: "/repo", fetchedCwds, fetch, refresh }),
    ).resolves.toBe(false);
    expect(fetchedCwds.has("/repo")).toBe(false);

    fetch.mockResolvedValueOnce();
    await expect(
      runInitialRemoteFetch({ cwd: "/repo", fetchedCwds, fetch, refresh }),
    ).resolves.toBe(true);
    expect(fetchedCwds.has("/repo")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("deduplicates successful and in-flight initial remote fetches", async () => {
    const fetchedCwds = new Set<string>();
    let resolveFetch: (() => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue();

    const first = runInitialRemoteFetch({ cwd: "/repo", fetchedCwds, fetch, refresh });
    await expect(
      runInitialRemoteFetch({ cwd: "/repo", fetchedCwds, fetch, refresh }),
    ).resolves.toBe(false);
    resolveFetch?.();
    await expect(first).resolves.toBe(true);
    await expect(
      runInitialRemoteFetch({ cwd: "/repo", fetchedCwds, fetch, refresh }),
    ).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

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
