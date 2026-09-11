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

  it("does not start a module loaded after disable", async () => {
    let loaded!: (module: { start: () => Promise<GatewayRuntimeHandle> }) => void;
    const start = vi.fn(async () => ({ stop: async () => undefined }));
    const controller = createGatewayController({
      port: unusedPort,
      load: () =>
        new Promise((resolve) => {
          loaded = resolve;
        }),
    });
    const enabling = controller.enable();
    await controller.disable();
    loaded({ start });
    await enabling;
    expect(start).not.toHaveBeenCalled();
    expect(controller.status()).toEqual({ state: "disabled" });
  });

  it("retains failed stale cleanup without hiding a newer running runtime", async () => {
    let finish!: (handle: GatewayRuntimeHandle) => void;
    const oldStop = vi
      .fn()
      .mockRejectedValueOnce(new Error("old cleanup"))
      .mockResolvedValue(undefined);
    const newStop = vi.fn(async () => undefined);
    const start = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ stop: newStop });
    const controller = createGatewayController({ port: unusedPort, load: async () => ({ start }) });
    const old = controller.enable();
    await Promise.resolve();
    await controller.disable();
    await controller.enable();
    finish({ stop: oldStop });
    await old;
    expect(controller.status()).toEqual({ state: "running" });
    await controller.disable();
    expect(oldStop).toHaveBeenCalledTimes(2);
    expect(newStop).toHaveBeenCalledOnce();
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

it("waits for in-flight disable before enabling a replacement", async () => {
  const stopped = Promise.withResolvers<void>();
  const stopStarted = Promise.withResolvers<void>();
  const start = vi
    .fn()
    .mockResolvedValueOnce({
      stop: () => {
        stopStarted.resolve();
        return stopped.promise;
      },
    })
    .mockResolvedValue({ stop: async () => {} });
  const controller = createGatewayController({ port: unusedPort, load: async () => ({ start }) });
  await controller.enable();
  const disabling = controller.disable();
  await stopStarted.promise;
  const enabling = controller.enable();
  expect(start).toHaveBeenCalledTimes(1);
  stopped.resolve();
  await disabling;
  expect(await enabling).toEqual({ state: "running" });
  expect(start).toHaveBeenCalledTimes(2);
  await controller.disable();
});
