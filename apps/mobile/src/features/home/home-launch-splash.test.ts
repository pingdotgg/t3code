import { expect, it, vi } from "vite-plus/test";

import { createLaunchSplashHomeRows, splashCanHide } from "./home-launch-splash";

const launched = {
  preferencesReady: true,
  shellCachesRead: true,
  homeRowsPending: false,
  waitEnded: false,
};

it.each([
  {
    name: "hides when the cached shells are read and no rows wait for layout",
    input: launched,
    hides: true,
  },
  {
    name: "waits while Home still lays out the cached rows",
    input: { ...launched, homeRowsPending: true },
    hides: false,
  },
  {
    name: "waits for the cached shells when Home has no rows yet",
    input: { ...launched, shellCachesRead: false },
    hides: false,
  },
  {
    name: "stops waiting for rows at the limit",
    input: { ...launched, homeRowsPending: true, waitEnded: true },
    hides: true,
  },
  {
    name: "stops waiting for a cache read that fails at the limit",
    input: { ...launched, shellCachesRead: false, homeRowsPending: true, waitEnded: true },
    hides: true,
  },
  {
    name: "waits for preferences even after the limit",
    input: { ...launched, preferencesReady: false, waitEnded: true },
    hides: false,
  },
])("the launch splash $name", ({ input, hides }) => {
  expect(splashCanHide(input)).toBe(hides);
});

it("the launch splash is held only while a Home list has rows to lay out", () => {
  const rows = createLaunchSplashHomeRows();
  const onChange = vi.fn();
  rows.subscribe(onChange);

  const release = rows.hold();
  expect(rows.pending()).toBe(true);
  // The server answered with no rows, or the list unmounted, before its first layout.
  release();
  expect(rows.pending(), "a list that lost its rows releases the splash").toBe(false);
  expect(onChange).toHaveBeenCalledTimes(2);

  const releaseLater = rows.hold();
  const releaseOther = rows.hold();
  releaseLater();
  release();
  expect(rows.pending(), "another list still has rows to lay out").toBe(true);

  rows.settle();
  expect(rows.pending()).toBe(false);
  releaseOther();
  rows.hold();
  expect(rows.pending(), "a list that mounts after the launch holds nothing").toBe(false);
});
