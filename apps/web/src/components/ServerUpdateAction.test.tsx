import type { Dispatch, ReactElement, SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/unstable/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";

const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  toast: vi.fn(),
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useEffect() {
      nextIndex();
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: hooks.useEffect,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn() }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { updateServer: Symbol("updateServer") },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateServer,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.toast },
}));

import { ServerUpdateAction } from "./ServerUpdateAction";

type ActionElement = ReactElement<{
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}>;

function renderAction(): ActionElement {
  hooks.beginRender();
  return ServerUpdateAction({
    environmentId: "env-test" as EnvironmentId,
    serverLabel: "Test server",
    selfUpdate: "boot-service",
    targetVersion: "0.0.29",
  }) as ActionElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ServerUpdateAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hooks.reset();
    testState.updateServer.mockReset();
    testState.toast.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a fresh reconnect timeout after a long install succeeds", async () => {
    const update =
      deferred<
        ReturnType<typeof AsyncResult.success<{ targetVersion: string; method: "boot-service" }>>
      >();
    testState.updateServer.mockReturnValue(update.promise);

    renderAction().props.onClick?.();
    expect(renderAction().props.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    update.resolve(
      AsyncResult.success({
        targetVersion: "0.0.29",
        method: "boot-service",
      }),
    );
    await flushPromises();

    // The click-based deadline would have fired by now. Success gets a fresh
    // twelve-minute reconnect window, so the action remains disabled.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(renderAction().props.disabled).toBe(true);
    expect(testState.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Server update timed out" }),
    );

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(renderAction().props.disabled).not.toBe(true);
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Server update timed out" }),
    );
  });
});
