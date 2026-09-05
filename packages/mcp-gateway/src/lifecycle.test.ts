import { describe, expect, it, vi } from "@effect/vitest";

import { createGatewayController, type GatewayRuntimeHandle } from "./lifecycle.ts";
import type { GatewayRuntimePort } from "./port.ts";

const unusedPort = {} as GatewayRuntimePort;

describe("gateway lifecycle isolation", () => {
  it("does not import or start gateway code while disabled", async () => {
    const load = vi.fn();
    const controller = createGatewayController({ port: unusedPort, load });

    expect(controller.status()).toEqual({ state: "disabled" });
    expect(load).not.toHaveBeenCalled();
    await controller.disable();
    expect(load).not.toHaveBeenCalled();
  });

  it("isolates startup failure and remains disable-able", async () => {
    const controller = createGatewayController({
      port: unusedPort,
      load: async () => {
        throw new Error("transport failed");
      },
    });

    await expect(controller.enable()).resolves.toEqual({
      state: "degraded",
      message: "transport failed",
    });
    expect(controller.status()).toEqual({ state: "degraded", message: "transport failed" });
    await controller.disable();
    expect(controller.status()).toEqual({ state: "disabled" });
  });

  it("stops a runtime that finishes starting after disable", async () => {
    let finishStart: ((handle: { readonly stop: () => Promise<void> }) => void) | undefined;
    const stop = vi.fn(async () => undefined);
    const controller = createGatewayController({
      port: unusedPort,
      load: async () => ({
        start: () =>
          new Promise((resolve) => {
            finishStart = resolve;
          }),
      }),
    });

    const enabling = controller.enable();
    await Promise.resolve();
    await controller.disable();
    finishStart?.({ stop });
    await enabling;

    expect(stop).toHaveBeenCalledOnce();
    expect(controller.status()).toEqual({ state: "disabled" });
  });

  it("starts and stops only the additive gateway runtime", async () => {
    const stop = vi.fn(async () => undefined);
    const start = vi.fn(async () => ({ stop }));
    const controller = createGatewayController({
      port: unusedPort,
      load: async () => ({ start }),
    });

    await expect(controller.enable()).resolves.toEqual({ state: "running" });
    expect(start).toHaveBeenCalledWith(unusedPort);
    await controller.disable();
    expect(stop).toHaveBeenCalledOnce();
    expect(controller.status()).toEqual({ state: "disabled" });
  });

  it("retains a runtime whose cleanup fails so disable can retry", async () => {
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("still listening"))
      .mockResolvedValue(undefined);
    const controller = createGatewayController({
      port: unusedPort,
      load: async () => ({ start: async () => ({ stop }) }),
    });

    await controller.enable();
    await expect(controller.disable()).rejects.toThrow("still listening");
    expect(controller.status()).toEqual({
      state: "degraded",
      message: "Failed to stop MCP gateway: still listening",
    });

    await expect(controller.disable()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(controller.status()).toEqual({ state: "disabled" });
  });

  it("retains a stale-start runtime when its first cleanup attempt fails", async () => {
    let finishStart: ((handle: GatewayRuntimeHandle) => void) | undefined;
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValue(undefined);
    const controller = createGatewayController({
      port: unusedPort,
      load: async () => ({
        start: () =>
          new Promise((resolve) => {
            finishStart = resolve;
          }),
      }),
    });

    const enabling = controller.enable();
    await Promise.resolve();
    await controller.disable();
    finishStart?.({ stop });

    await expect(enabling).resolves.toEqual({
      state: "degraded",
      message: "Failed to stop MCP gateway: cleanup failed",
    });
    await controller.disable();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(controller.status()).toEqual({ state: "disabled" });
  });
});
