import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, createElement, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { createThreadParking, useThreadParking } from "./threadParking";

function deferredSuccess() {
  let resolve!: (value: ReturnType<typeof AsyncResult.success<void>>) => void;
  const promise = new Promise<ReturnType<typeof AsyncResult.success<void>>>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setup() {
  let activeThreadKey: string | null = "a";
  let orderedThreadKeys = ["a", "b", "c"];
  const parked = new Set<string>();
  const navigate = vi.fn();
  const fallback = vi.fn();
  const read = () => ({
    activeThreadKey,
    orderedThreadKeys,
    isParked: (key: string) => parked.has(key),
    planNext: (key: string) => () => navigate(key),
    planFallback: (key: string) => () => fallback(key),
  });
  return {
    parking: createThreadParking(read),
    anotherScope: () => createThreadParking(read),
    setActive: (key: string | null) => {
      activeThreadKey = key;
    },
    setOrder: (keys: string[]) => {
      orderedThreadKeys = keys;
    },
    parked,
    navigate,
    fallback,
  };
}

const success = () => Promise.resolve(AsyncResult.success(undefined));

describe("thread parking", () => {
  it("keeps the pending scope across renders and reads the latest route", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const navigate = vi.fn();
    let parking!: ReturnType<typeof useThreadParking>;
    function Probe({ active }: { active: string }) {
      const workflow = useThreadParking(() => ({
        activeThreadKey: active,
        orderedThreadKeys: ["a", "b", "c"],
        isParked: () => false,
        planNext: (key) => () => navigate(key),
        planFallback: () => navigate,
      }));
      useEffect(() => {
        parking = workflow;
      }, [workflow]);
      return null;
    }
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(createElement(Probe, { active: "a" }));
      });
      const completion = deferredSuccess();
      const pending = parking.run("a", () => completion.promise);
      await act(() => renderer?.update(createElement(Probe, { active: "c" })));
      await expect(parking.run("a", success)).resolves.toEqual({ status: "skipped" });
      completion.resolve(AsyncResult.success(undefined));
      await pending;
      expect(navigate).not.toHaveBeenCalled();
      expect(parking.isPending("a")).toBe(false);
    } finally {
      await act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("captures the next thread before the command changes the list", async () => {
    const s = setup();
    const completion = deferredSuccess();
    const pending = s.parking.run("a", () => completion.promise);
    s.setOrder(["c"]);
    completion.resolve(AsyncResult.success(undefined));
    await expect(pending).resolves.toEqual({ status: "success" });
    expect(s.navigate).toHaveBeenCalledWith("b");
  });

  it("respects navigation while an action is pending", async () => {
    const s = setup();
    const completion = deferredSuccess();
    const pending = s.parking.run("a", () => completion.promise);
    s.setActive("c");
    completion.resolve(AsyncResult.success(undefined));
    await pending;
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.fallback).not.toHaveBeenCalled();
  });

  it("does not navigate when parking a background thread", async () => {
    const s = setup();
    await s.parking.run("b", success);
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.fallback).not.toHaveBeenCalled();
  });

  it("skips parked threads and every thread leaving in the same batch", async () => {
    const s = setup();
    s.setOrder(["d", "a", "b", "c"]);
    s.parked.add("b");
    await s.parking.run("a", success, new Set(["a", "c"]));
    expect(s.navigate).toHaveBeenCalledWith("d");
  });

  it("uses the project draft fallback when no remaining thread exists", async () => {
    const s = setup();
    s.parked.add("b");
    s.parked.add("c");
    await s.parking.run("a", success);
    expect(s.fallback).toHaveBeenCalledWith("a");
    expect(s.navigate).not.toHaveBeenCalled();
  });

  it("falls back when the current thread is absent or the successor disappeared", async () => {
    const s = setup();
    s.setOrder([]);
    await s.parking.run("a", success);
    expect(s.fallback).toHaveBeenCalledWith("a");
    const fallback = vi.fn();
    const parking = createThreadParking(() => ({
      activeThreadKey: "a",
      orderedThreadKeys: ["a", "b"],
      isParked: () => false,
      planNext: () => null,
      planFallback: () => fallback,
    }));
    await parking.run("a", success);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("suppresses duplicate commands within the same pending scope", async () => {
    const s = setup();
    const completion = deferredSuccess();
    const pending = s.parking.run("a", () => completion.promise);
    const duplicate = vi.fn(success);
    expect(s.parking.isPending("a")).toBe(true);
    await expect(s.parking.run("a", duplicate)).resolves.toEqual({ status: "skipped" });
    expect(duplicate).not.toHaveBeenCalled();
    await s.anotherScope().run("a", duplicate);
    expect(duplicate).toHaveBeenCalledOnce();
    completion.resolve(AsyncResult.success(undefined));
    await pending;
    expect(s.parking.isPending("a")).toBe(false);
  });

  it("reports typed failure without navigation and releases the pending guard", async () => {
    const s = setup();
    const error = new Error("failed");
    await expect(
      s.parking.run("a", async () => AsyncResult.failure(Cause.fail(error))),
    ).resolves.toEqual({ status: "failure", error });
    expect(s.navigate).not.toHaveBeenCalled();
    await s.parking.run("a", success);
    expect(s.navigate).toHaveBeenCalledOnce();
  });

  it("keeps interruptions silent and releases the pending guard on thrown failures", async () => {
    const s = setup();
    await expect(
      s.parking.run("a", async () => AsyncResult.failure(Cause.interrupt())),
    ).resolves.toEqual({ status: "interrupted" });
    expect(s.navigate).not.toHaveBeenCalled();
    await expect(
      s.parking.run("a", async () => {
        throw new Error("rejected");
      }),
    ).rejects.toThrow("rejected");
    expect(s.parking.isPending("a")).toBe(false);
  });
});
