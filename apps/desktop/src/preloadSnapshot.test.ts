import { expect, it } from "vite-plus/test";

import { createPreloadSnapshot } from "./preloadSnapshot.ts";

it("keeps reads responsive while the main process is busy and shares a refresh", async () => {
  let synchronousReads = 0;
  let asynchronousReads = 0;
  let complete!: (value: string[]) => void;
  const latest = new Promise<string[]>((resolve) => {
    complete = resolve;
  });
  const snapshot = createPreloadSnapshot(
    () => {
      synchronousReads++;
      return ["primary"];
    },
    () => {
      asynchronousReads++;
      return latest;
    },
  );

  expect(snapshot.read()).toEqual(["primary"]);
  const refresh = snapshot.refresh();
  expect(snapshot.refresh()).toBe(refresh);
  for (let read = 0; read < 1_000; read++) expect(snapshot.read()).toEqual(["primary"]);
  expect(synchronousReads).toBe(1);
  expect(asynchronousReads).toBe(1);

  complete(["primary", "wsl"]);
  await refresh;
  expect(snapshot.read()).toEqual(["primary", "wsl"]);
  expect(synchronousReads).toBe(1);
});

it("preserves the last successful topology after IPC fails and recovers on the next refresh", async () => {
  let fail = true;
  const snapshot = createPreloadSnapshot(
    () => ["primary", "wsl"],
    async () => {
      if (fail) throw new Error("IPC unavailable");
      return [];
    },
  );
  expect(snapshot.read()).toEqual(["primary", "wsl"]);
  await expect(snapshot.refresh()).rejects.toThrow("IPC unavailable");
  expect(snapshot.read()).toEqual(["primary", "wsl"]);
  fail = false;
  await snapshot.refresh();
  expect(snapshot.read()).toEqual([]);
});

it("uses an asynchronous startup result without a synchronous IPC read", async () => {
  const snapshot = createPreloadSnapshot(
    () => {
      throw new Error("unexpected synchronous IPC");
    },
    async () => ["wsl"],
  );
  await snapshot.refresh();
  expect(snapshot.read()).toEqual(["wsl"]);
});
