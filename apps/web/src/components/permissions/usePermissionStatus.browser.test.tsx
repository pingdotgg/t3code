import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { usePermissionStatus } from "./usePermissionStatus";

type Status = { screen: boolean; accessibility: boolean };
const check = vi.fn<() => Promise<Status>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root | null;
let current: ReturnType<typeof usePermissionStatus<keyof Status>>;
let visibility: DocumentVisibilityState;

function Probe() {
  const status = usePermissionStatus(check, { screen: false, accessibility: false });
  useEffect(() => {
    current = status;
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  check.mockReset().mockResolvedValue({ screen: false, accessibility: false });
  root = null;
});
afterEach(async () => {
  await unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "visibilityState");
});

async function start() {
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Probe />));
}
async function unmount() {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
}
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

it("unlocks Continue only for required grants and relocks on revocation", async () => {
  await start();
  expect(current.isReady(["screen"])).toBe(false);
  check.mockResolvedValue({ screen: true, accessibility: false });
  await tick(1500);
  expect(current.isReady(["screen"])).toBe(true);
  expect(current.isReady(["screen", "accessibility"])).toBe(false);
  check.mockResolvedValue({ screen: true, accessibility: true });
  await tick(1500);
  expect(current.isReady(["screen", "accessibility"])).toBe(true);
  check.mockResolvedValue({ screen: false, accessibility: true });
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(current.isReady(["screen"])).toBe(false);
});

it("does not overlap checks and discards completion after closing", async () => {
  const pending = deferred<Status>();
  check.mockReturnValue(pending.promise);
  await start();
  await tick(4500);
  window.dispatchEvent(new Event("focus"));
  expect(check).toHaveBeenCalledTimes(1);
  const last = current;
  await unmount();
  await act(async () => pending.resolve({ screen: true, accessibility: true }));
  expect(last.isReady(["screen"])).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("pauses in the background and blocks stale grants after a check failure", async () => {
  check.mockResolvedValue({ screen: true, accessibility: true });
  await start();
  expect(current.isReady(["screen"])).toBe(true);
  visibility = "hidden";
  await tick(3000);
  expect(check).toHaveBeenCalledTimes(1);
  check.mockRejectedValue(new Error("IPC unavailable"));
  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(current.isReady(["screen"])).toBe(false);
  expect(current.error).not.toBeNull();
  check.mockResolvedValue({ screen: true, accessibility: true });
  await tick(1500);
  expect(current.isReady(["screen"])).toBe(true);
});
