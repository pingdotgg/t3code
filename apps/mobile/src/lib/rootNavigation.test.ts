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

const {
  attachRootNavigation,
  flushRootNavigationQueue,
  linkToRootPath,
  rootNavigationRef,
  whenRootNavigationReady,
} = await import("./rootNavigation");

function fakeContainer() {
  return { isReady: () => true } as NavigationContainerRef<ReactNavigation.RootParamList>;
}

it("keeps the newer container when an older root unmounts after it attached", () => {
  // Android activity replacement mounts the new root before the old one unmounts.
  const detachPrevious = attachRootNavigation(fakeContainer());
  const current = fakeContainer();
  const detachCurrent = attachRootNavigation(current);

  detachPrevious();
  expect(rootNavigationRef.current).toBe(current);
  expect(rootNavigationRef.isReady()).toBe(true);

  detachCurrent();
  expect(rootNavigationRef.current).toBeNull();
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

  const detach = attachRootNavigation(fakeContainer());
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
  const detach = attachRootNavigation(fakeContainer());
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
