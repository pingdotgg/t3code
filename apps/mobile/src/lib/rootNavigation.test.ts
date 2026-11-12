import { expect, it, vi } from "vite-plus/test";
import type { NavigationContainerRef } from "@react-navigation/native";

vi.mock("@react-navigation/native", () => ({
  createNavigationContainerRef: () => ({
    current: null as { isReady(): boolean } | null,
    isReady() {
      return this.current?.isReady() ?? false;
    },
    dispatched: [] as Array<unknown>,
    dispatch(action: unknown) {
      this.dispatched.push(action);
    },
    getRootState: () => ({ key: "root" }),
  }),
}));

const { activateAppWindow, closeAppWindow } = await import("./appWindows");
const {
  attachRootNavigation,
  flushRootNavigationQueue,
  rootNavigationWindowId,
  rootNavigationWindowStatus,
  linkToRootPath,
  rootNavigationRef,
  whenRootNavigationReady,
} = await import("./rootNavigation");

function fakeContainer() {
  return { isReady: () => true } as NavigationContainerRef<ReactNavigation.RootParamList>;
}

it("keeps the newer container when an older root unmounts after it attached", () => {
  // Android activity replacement mounts the new root before the old one unmounts.
  const detachPrevious = attachRootNavigation(1, fakeContainer());
  const current = fakeContainer();
  const detachCurrent = attachRootNavigation(2, current);

  detachPrevious();
  expect(rootNavigationRef.current).toBe(current);
  expect(rootNavigationRef.isReady()).toBe(true);

  detachCurrent();
  expect(rootNavigationRef.current).toBeNull();
});

it("follows the window in use, and falls back when it closes", () => {
  const first = fakeContainer();
  const second = fakeContainer();
  const detachFirst = attachRootNavigation(1, first);
  activateAppWindow(1);
  const detachSecond = attachRootNavigation(2, second);
  expect(rootNavigationRef.current).toBe(first);
  expect(rootNavigationWindowStatus(2)).toBe("waiting");

  activateAppWindow(2);
  expect(rootNavigationRef.current).toBe(second);
  activateAppWindow(1);
  expect(rootNavigationRef.current).toBe(first);
  expect(rootNavigationWindowId()).toBe(1);
  expect(rootNavigationWindowStatus(1)).toBe("current");

  closeAppWindow(1);
  detachFirst();
  expect(rootNavigationRef.current).toBe(second);
  expect(rootNavigationWindowStatus(1)).toBe("closed");
  closeAppWindow(2);
  detachSecond();
  expect(rootNavigationRef.current).toBeNull();
});

it("runs queued navigation when a ready window takes over from one still mounting", () => {
  const navigate = vi.fn();
  const detachReady = attachRootNavigation(1, fakeContainer());
  activateAppWindow(1);
  const mounting = {
    isReady: () => false,
  } as NavigationContainerRef<ReactNavigation.RootParamList>;
  const detachMounting = attachRootNavigation(2, mounting);
  activateAppWindow(2);
  whenRootNavigationReady(navigate);
  expect(navigate).not.toHaveBeenCalled();

  closeAppWindow(2);
  detachMounting();
  expect(navigate).toHaveBeenCalledOnce();
  closeAppWindow(1);
  detachReady();
});

it("holds navigation until the container is ready, then runs it once", () => {
  const navigate = vi.fn();
  const failing = vi.fn(() => {
    throw new Error("unknown route");
  });
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  whenRootNavigationReady(failing);
  whenRootNavigationReady(navigate);
  expect(navigate).not.toHaveBeenCalled();

  const detach = attachRootNavigation(1, fakeContainer());
  flushRootNavigationQueue();
  flushRootNavigationQueue();
  expect(failing).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledOnce();
  expect(logged).toHaveBeenCalledOnce();

  whenRootNavigationReady(navigate);
  expect(navigate).toHaveBeenCalledTimes(2);
  detach();
  logged.mockRestore();
});

it("rejects an href without a leading slash, as useLinkTo does", () => {
  const toAction = vi.fn(() => ({ type: "NAVIGATE" }));
  const detach = attachRootNavigation(1, fakeContainer());
  const { dispatched } = rootNavigationRef as unknown as { dispatched: Array<unknown> };

  expect(() => linkToRootPath("threads/env/t1", toAction)).toThrow(
    "The href must start with '/' (threads/env/t1).",
  );
  expect(toAction).not.toHaveBeenCalled();

  linkToRootPath("/threads/env/t1", toAction);
  expect(toAction).toHaveBeenCalledExactlyOnceWith("/threads/env/t1");
  expect(dispatched).toEqual([{ target: "root", type: "NAVIGATE" }]);
  detach();
});
