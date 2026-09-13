import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createProviderCatalogRefreshRunner,
  providerCatalogRefreshError,
} from "./provider-catalog-refresh";

describe("mobile provider catalog refresh", () => {
  it("requests model discovery for the selected environment and deduplicates pending taps", async () => {
    let resolveRefresh: ((value: "refreshed") => void) | undefined;
    const refreshProviders = vi.fn(
      () =>
        new Promise<"refreshed">((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const refresh = createProviderCatalogRefreshRunner(refreshProviders);
    const environmentId = EnvironmentId.make("environment-mobile");

    const first = refresh(environmentId);
    const second = refresh(environmentId);

    expect(second).toBe(first);
    expect(refreshProviders).toHaveBeenCalledOnce();
    expect(refreshProviders).toHaveBeenCalledWith({
      environmentId,
      input: { refreshModels: true },
    });

    resolveRefresh?.("refreshed");
    await expect(first).resolves.toBe("refreshed");
  });

  it("reports a discovery error and allows retry after the failed command settles", async () => {
    const failure = AsyncResult.failure<never, Error>(Cause.fail(new Error("discovery failed")));
    const success = AsyncResult.success("refreshed");
    let callCount = 0;
    const refreshProviders = vi.fn(async () => (callCount++ === 0 ? failure : success));
    const refresh = createProviderCatalogRefreshRunner(refreshProviders);
    const environmentId = EnvironmentId.make("environment-mobile");

    expect(providerCatalogRefreshError(await refresh(environmentId))).toBe("discovery failed");
    expect(providerCatalogRefreshError(await refresh(environmentId))).toBeNull();
    expect(refreshProviders).toHaveBeenCalledTimes(2);
  });
});
