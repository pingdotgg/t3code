import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { refreshProvidersAndReload } from "./reloadWindow";

describe("refreshProvidersAndReload", () => {
  it("waits for every environment refresh before reloading", async () => {
    const firstEnvironmentId = EnvironmentId.make("environment-first");
    const secondEnvironmentId = EnvironmentId.make("environment-second");
    const refreshResolvers = new Map<EnvironmentId, () => void>();
    const refreshProviders = vi.fn(
      (environmentId: EnvironmentId) =>
        new Promise<void>((resolve) => {
          refreshResolvers.set(environmentId, resolve);
        }),
    );
    const onRefreshStart = vi.fn();
    const reload = vi.fn();

    const operation = refreshProvidersAndReload({
      environmentIds: [firstEnvironmentId, secondEnvironmentId],
      refreshProviders,
      onRefreshStart,
      reload,
    });
    await Promise.resolve();

    expect(onRefreshStart).toHaveBeenCalledOnce();
    expect(refreshProviders).toHaveBeenCalledWith(firstEnvironmentId);
    expect(refreshProviders).toHaveBeenCalledWith(secondEnvironmentId);
    expect(reload).not.toHaveBeenCalled();

    refreshResolvers.get(firstEnvironmentId)?.();
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();

    refreshResolvers.get(secondEnvironmentId)?.();
    await operation;
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads after refresh failures settle", async () => {
    const reload = vi.fn();

    await refreshProvidersAndReload({
      environmentIds: [
        EnvironmentId.make("environment-available"),
        EnvironmentId.make("environment-unavailable"),
      ],
      refreshProviders: (environmentId) =>
        environmentId === "environment-unavailable"
          ? Promise.reject(new Error("disconnected"))
          : Promise.resolve(),
      onRefreshStart: vi.fn(),
      reload,
    });

    expect(reload).toHaveBeenCalledOnce();
  });
});
