import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_UPDATE_RESTORE_MAX_AGE_MS,
  DESKTOP_UPDATE_RESTORE_STORAGE_KEY,
  resolveDesktopUpdateRestoreLocation,
  saveDesktopUpdateRestoreLocation,
  takeDesktopUpdateRestoreLocation,
} from "./desktopUpdateRestore";
import { removeLocalStorageItem } from "./hooks/useLocalStorage";

describe("resolveDesktopUpdateRestoreLocation", () => {
  const now = 1_000_000;

  it("returns a fresh route path", () => {
    expect(
      resolveDesktopUpdateRestoreLocation({ location: "/env-1/thread-1", savedAt: now }, now),
    ).toBe("/env-1/thread-1");
  });

  it("drops stale hints", () => {
    const savedAt = now - DESKTOP_UPDATE_RESTORE_MAX_AGE_MS - 1;
    expect(
      resolveDesktopUpdateRestoreLocation({ location: "/env-1/thread-1", savedAt }, now),
    ).toBeNull();
  });

  it("drops hints saved in the future", () => {
    expect(
      resolveDesktopUpdateRestoreLocation({ location: "/env-1/thread-1", savedAt: now + 1 }, now),
    ).toBeNull();
  });

  it("drops the index route and anything that is not a route path", () => {
    expect(resolveDesktopUpdateRestoreLocation({ location: "/", savedAt: now }, now)).toBeNull();
    expect(resolveDesktopUpdateRestoreLocation({ location: "", savedAt: now }, now)).toBeNull();
    expect(
      resolveDesktopUpdateRestoreLocation({ location: "//evil.example", savedAt: now }, now),
    ).toBeNull();
    expect(
      resolveDesktopUpdateRestoreLocation({ location: "https://evil.example", savedAt: now }, now),
    ).toBeNull();
  });
});

describe("takeDesktopUpdateRestoreLocation", () => {
  beforeEach(() => {
    removeLocalStorageItem(DESKTOP_UPDATE_RESTORE_STORAGE_KEY);
  });

  it("returns the saved route once", () => {
    saveDesktopUpdateRestoreLocation("/env-1/thread-1", 5_000);

    expect(takeDesktopUpdateRestoreLocation(6_000)).toBe("/env-1/thread-1");
    expect(takeDesktopUpdateRestoreLocation(6_000)).toBeNull();
  });

  it("returns null when nothing was saved", () => {
    expect(takeDesktopUpdateRestoreLocation()).toBeNull();
  });
});
