import { expect, it, vi } from "vite-plus/test";

import { createPreloadSnapshot } from "./preloadSnapshot.ts";

it("serves the startup snapshot while a shared asynchronous refresh is pending", async () => {
  const initial = ["primary"];
  const latest = Promise.withResolvers<string[]>();
  const readInitial = vi.fn(() => initial);
  const readLatest = vi.fn(() => latest.promise);
  const snapshot = createPreloadSnapshot(readInitial, readLatest);

  expect(snapshot.read()).toBe(initial);
  const first = snapshot.refresh();
  const second = snapshot.refresh();
  expect(snapshot.read()).toBe(initial);
  expect(snapshot.read()).toBe(initial);
  expect(readInitial).toHaveBeenCalledTimes(1);
  expect(readLatest).toHaveBeenCalledTimes(1);

  const connected = ["primary", "wsl"];
  latest.resolve(connected);
  expect(await first).toBe(connected);
  expect(await second).toBe(connected);
  expect(snapshot.read()).toBe(connected);
  expect(readInitial).toHaveBeenCalledTimes(1);
});

it("retains an async snapshot through failure and replaces it on successful recovery", async () => {
  const connected = ["primary", "wsl"];
  const readInitial = vi.fn(() => ["stale"]);
  const readLatest = vi
    .fn<() => Promise<string[]>>()
    .mockResolvedValueOnce(connected)
    .mockRejectedValueOnce(new Error("IPC unavailable"))
    .mockResolvedValueOnce([]);
  const snapshot = createPreloadSnapshot(readInitial, readLatest);

  await snapshot.refresh();
  expect(snapshot.read()).toBe(connected);
  await expect(snapshot.refresh()).rejects.toThrow("IPC unavailable");
  expect(snapshot.read()).toBe(connected);
  await expect(snapshot.refresh()).resolves.toEqual([]);
  expect(snapshot.read()).toEqual([]);
  expect(readInitial).not.toHaveBeenCalled();
});
