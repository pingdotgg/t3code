import { expect, it } from "vite-plus/test";

import { splashCanHide } from "./home-launch-splash";

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
