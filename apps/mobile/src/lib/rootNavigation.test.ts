import { expect, it, vi } from "vite-plus/test";
import type { NavigationContainerRef } from "@react-navigation/native";

vi.mock("@react-navigation/native", () => ({
  createNavigationContainerRef: () => ({
    current: null as { isReady(): boolean } | null,
    isReady() {
      return this.current?.isReady() ?? false;
    },
  }),
}));

const { attachRootNavigation, rootNavigationRef } = await import("./rootNavigation");

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
