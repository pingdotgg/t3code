import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ get: vi.fn(), request: vi.fn() }));
vi.mock("expo-image-picker", () => ({
  getMediaLibraryPermissionsAsync: mocks.get,
  requestMediaLibraryPermissionsAsync: mocks.request,
}));
import {
  createRecentPhotosAccessOperations,
  requestRecentPhotosAccess,
} from "./recentPhotosAccess";

beforeEach(() => vi.resetAllMocks());

it.each([true, false])(
  "returns the user's first permission decision: granted=%s",
  async (granted) => {
    mocks.get.mockResolvedValue({ granted: false, canAskAgain: true });
    const decision = { granted, canAskAgain: false };
    mocks.request.mockResolvedValue(decision);
    expect(await requestRecentPhotosAccess()).toEqual(decision);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  },
);

it.each([
  { granted: false, canAskAgain: false, accessPrivileges: "none" },
  { granted: true, canAskAgain: true, accessPrivileges: "limited" },
  { granted: true, canAskAgain: true, accessPrivileges: "all" },
])("does not prompt again for $accessPrivileges access", async (access) => {
  mocks.get.mockResolvedValue(access);
  expect(await requestRecentPhotosAccess()).toEqual(access);
  expect(mocks.request).not.toHaveBeenCalled();
});

it("ignores a denied refresh that finishes after a newer permission grant", async () => {
  const operations = createRecentPhotosAccessOperations();
  const stale = Promise.withResolvers<{ granted: boolean; canAskAgain: boolean }>();
  const granted = { granted: true, canAskAgain: true };
  const apply = vi.fn();
  mocks.get.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(granted);
  const refresh = operations.run(mocks.get, apply, vi.fn());
  await operations.run(requestRecentPhotosAccess, apply, vi.fn());
  stale.resolve({ granted: false, canAskAgain: false });
  await refresh;
  expect(apply.mock.calls).toEqual([[granted]]);
});

it("ignores stale failures and invalidated operations", async () => {
  const operations = createRecentPhotosAccessOperations();
  const stale = Promise.withResolvers<never>();
  const apply = vi.fn();
  const onError = vi.fn();
  mocks.get.mockReturnValueOnce(stale.promise);
  const pending = operations.run(mocks.get, apply, onError);
  operations.invalidate();
  stale.reject(new Error("old permission query failed"));
  await pending;
  expect(apply).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});
