import { act, render, fakeTimers } from "../../../test/render";
import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

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

async function start(
  onStatus: (status: ReturnType<typeof usePermissionStatus<keyof Status>>) => void,
) {
  function Probe() {
    const status = usePermissionStatus(check, { screen: false, accessibility: false });
    useEffect(() => onStatus(status));
    return null;
  }
  return render(<Probe />, { router: false });
}
function setup() {
  check.mockReset().mockResolvedValue({ screen: false, accessibility: false });
}
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

it("unlocks Continue only for required grants and relocks on revocation", async () => {
  setup();
  using _timers = fakeTimers();
  let current!: ReturnType<typeof usePermissionStatus<keyof Status>>;
  let visibility: DocumentVisibilityState = "visible";
  using _visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockImplementation(() => visibility);
  await using _screen = await start((status) => {
    current = status;
  });
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
  setup();
  using _timers = fakeTimers();
  let current!: ReturnType<typeof usePermissionStatus<keyof Status>>;
  let visibility: DocumentVisibilityState = "visible";
  using _visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockImplementation(() => visibility);
  const pending = deferred<Status>();
  check.mockReturnValue(pending.promise);
  await using screen = await start((status) => {
    current = status;
  });
  await tick(4500);
  window.dispatchEvent(new Event("focus"));
  expect(check).toHaveBeenCalledTimes(1);
  const last = current;
  await screen.unmount();
  await act(async () => pending.resolve({ screen: true, accessibility: true }));
  expect(last.isReady(["screen"])).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("pauses in the background and blocks stale grants after a check failure", async () => {
  setup();
  using _timers = fakeTimers();
  let current!: ReturnType<typeof usePermissionStatus<keyof Status>>;
  let visibility: DocumentVisibilityState = "visible";
  using _visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockImplementation(() => visibility);
  check.mockResolvedValue({ screen: true, accessibility: true });
  await using _screen = await start((status) => {
    current = status;
  });
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
