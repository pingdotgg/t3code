import { describe, expect, it, vi } from "vite-plus/test";

import {
  mergeVersionControlRefreshOptions,
  retainPullRefreshIndicator,
  retryInterruptedVersionControlRequest,
  runAutomaticRemoteFetch,
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

  it("releases a failed automatic fetch so a later interval can retry it", async () => {
    const inFlightCwds = new Set<string>();
    const fetch = vi.fn<() => Promise<boolean>>().mockRejectedValueOnce(new Error("offline"));
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue();

    await expect(
      runAutomaticRemoteFetch({ cwd: "/repo", inFlightCwds, fetch, refresh }),
    ).resolves.toBe(false);
    expect(inFlightCwds.has("/repo")).toBe(false);

    fetch.mockResolvedValueOnce(true);
    await expect(
      runAutomaticRemoteFetch({ cwd: "/repo", inFlightCwds, fetch, refresh }),
    ).resolves.toBe(true);
    expect(inFlightCwds.has("/repo")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("deduplicates in-flight automatic fetches and skips cached-fetch reconciliation", async () => {
    const inFlightCwds = new Set<string>();
    let resolveFetch: (() => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveFetch = () => resolve(true);
        }),
    );
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue();

    const first = runAutomaticRemoteFetch({ cwd: "/repo", inFlightCwds, fetch, refresh });
    await expect(
      runAutomaticRemoteFetch({ cwd: "/repo", inFlightCwds, fetch, refresh }),
    ).resolves.toBe(false);
    resolveFetch?.();
    await expect(first).resolves.toBe(true);

    fetch.mockResolvedValueOnce(false);
    await expect(
      runAutomaticRemoteFetch({ cwd: "/repo", inFlightCwds, fetch, refresh }),
    ).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("promotes queued working-tree work to a full refresh", () => {
    expect(
      mergeVersionControlRefreshOptions(
        { pull: true, refresh: "working-tree" },
        { refresh: "full" },
      ),
    ).toEqual({ pull: true, refresh: "full" });
    expect(mergeVersionControlRefreshOptions(null, { refresh: "working-tree" })).toEqual({
      refresh: "working-tree",
    });
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
