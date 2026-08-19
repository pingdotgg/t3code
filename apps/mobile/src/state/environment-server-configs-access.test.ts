import { describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

const mockEnvironmentServerConfigsAtom = vi.hoisted(() => ({
  label: "environment-server-configs",
}));

vi.mock("./server", () => ({
  environmentServerConfigsAtom: mockEnvironmentServerConfigsAtom,
}));

import {
  readEnvironmentServerConfigs,
  subscribeEnvironmentServerConfigs,
} from "./environment-server-configs-access";
import { environmentServerConfigsAtom } from "./server";

describe("environment server configs access boundary", () => {
  it("reads environmentServerConfigsAtom from the registry", () => {
    const configs = new Map<EnvironmentId, ServerConfig>();
    const get = vi.fn(() => configs);

    expect(readEnvironmentServerConfigs({ get })).toBe(configs);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(environmentServerConfigsAtom);
  });

  it("subscribes to config changes and exposes cleanup", () => {
    const cleanup = vi.fn();
    const subscribe = vi.fn(() => cleanup);
    const listener = vi.fn();

    const unsubscribe = subscribeEnvironmentServerConfigs(listener, { subscribe });

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(environmentServerConfigsAtom, listener);
    unsubscribe();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("returns a changed registry value on repeated reads instead of a captured map", () => {
    const first = new Map<EnvironmentId, ServerConfig>();
    const second = new Map<EnvironmentId, ServerConfig>();
    let liveConfigs = first;
    const get = vi.fn(() => liveConfigs);

    expect(readEnvironmentServerConfigs({ get })).toBe(first);

    liveConfigs = second;
    expect(readEnvironmentServerConfigs({ get })).toBe(second);
    expect(readEnvironmentServerConfigs({ get })).not.toBe(first);
    expect(get).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenNthCalledWith(1, environmentServerConfigsAtom);
    expect(get).toHaveBeenNthCalledWith(2, environmentServerConfigsAtom);
    expect(get).toHaveBeenNthCalledWith(3, environmentServerConfigsAtom);
  });
});
