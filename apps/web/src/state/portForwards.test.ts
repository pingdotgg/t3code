import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./session", () => ({
  environmentSession: {
    transportSessionAtom: () => Atom.make(AsyncResult.success(Option.some({}))),
  },
}));

const { forwardLocalitiesAtom } = await import("./portForwards");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("forward locality", () => {
  it("probes again after a failed probe instead of staying unknown", async () => {
    vi.useFakeTimers();
    const sharesLoopback = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("tunnel dial refused"))
      .mockResolvedValue(false);
    vi.stubGlobal("window", { desktopBridge: { preview: { sharesLoopback } } });
    const registry = AtomRegistry.make();
    const environmentId = EnvironmentId.make("env-remote");
    const atom = forwardLocalitiesAtom(JSON.stringify([environmentId]));
    const unmount = registry.mount(atom);

    await vi.advanceTimersByTimeAsync(0);
    expect(sharesLoopback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sharesLoopback).toHaveBeenCalledTimes(2);
    expect(registry.get(atom)).toEqual(["remote"]);
    unmount();
  });
});
