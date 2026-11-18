import { describe, expect, it } from "vite-plus/test";

import { createProfileReconciler, type ProfileBinding } from "./profileReconcile.ts";

interface Read {
  readonly isCurrent: () => boolean;
  readonly resolve: (binding: ProfileBinding | null) => void;
  readonly reject: (error: unknown) => void;
}

/** A reconciler over a refresh the test answers by hand, one read at a time. */
function harness() {
  const local = { scope: "orbit:gateway" as string | null };
  const reads: Read[] = [];
  const waiters: { count: number; resolve: (read: Read) => void }[] = [];
  const errors: unknown[] = [];
  const reconciler = createProfileReconciler({
    scope: () => local.scope,
    refresh: (isCurrent) =>
      new Promise((resolve, reject) => {
        reads.push({ isCurrent, resolve, reject });
        for (const waiter of waiters.splice(0)) {
          if (reads.length >= waiter.count) waiter.resolve(reads[waiter.count - 1]!);
          else waiters.push(waiter);
        }
      }),
    onError: (error) => errors.push(error),
  });
  /** The `count`th read, once the reconciler has started it. */
  const read = (count: number): Promise<Read> =>
    reads.length >= count
      ? Promise.resolve(reads[count - 1]!)
      : new Promise((resolve) => waiters.push({ count, resolve }));
  const bound = async (binding: ProfileBinding | null): Promise<void> => {
    const next = reads.length + 1;
    const done = reconciler.reconcile();
    (await read(next)).resolve(binding);
    await done;
  };
  return { local, reads, errors, reconciler, read, bound };
}

describe("profile reconciler", () => {
  it("reads once for a burst and again for a newer notice that arrived during the read", async () => {
    const { reconciler, reads, read } = harness();
    const done = reconciler.reconcile();
    const first = await read(1);
    // Notices for writes that land after the Gateway answered this read.
    reconciler.notify({ profileId: 1, version: 6 });
    reconciler.notify({ profileId: 1, version: 7 });
    reconciler.notify({ profileId: 1, version: 6 });
    first.resolve({ profileId: 1, version: 5 });
    (await read(2)).resolve({ profileId: 1, version: 7 });
    await done;
    expect(reads).toHaveLength(2);

    // Duplicates and out-of-order notices of what it already holds start nothing.
    expect(reconciler.notify({ profileId: 1, version: 7 })).toBeNull();
    expect(reconciler.notify({ profileId: 1, version: 6 })).toBeNull();
    expect(reads).toHaveLength(2);
  });

  it("coalesces notices while idle into one read", async () => {
    const { reconciler, reads, read, bound } = harness();
    await bound({ profileId: 1, version: 5 });
    const done = reconciler.notify({ profileId: 1, version: 6 });
    expect(reconciler.notify({ profileId: 1, version: 8 })).toBe(done);
    expect(reconciler.notify({ profileId: 1, version: 7 })).toBe(done);
    (await read(2)).resolve({ profileId: 1, version: 8 });
    await done;
    expect(reads).toHaveLength(2);
  });

  it.each(["notice", "reconnect"] as const)(
    "handles a %s as the prior read finishes",
    async (kind) => {
      const first = Promise.withResolvers<ProfileBinding | null>();
      const started = Promise.withResolvers<void>();
      let reads = 0;
      const reconciler = createProfileReconciler({
        scope: () => "orbit:gateway",
        refresh: () => {
          reads += 1;
          started.resolve();
          return reads === 1 ? first.promise : Promise.resolve({ profileId: 1, version: 6 });
        },
      });
      const initial = reconciler.reconcile();
      await started.promise;
      first.resolve({ profileId: 1, version: 5 });
      await Promise.resolve().then(() =>
        kind === "notice"
          ? reconciler.notify({ profileId: 1, version: 6 })
          : reconciler.reconcile(),
      );
      await initial;
      expect(reads).toBe(2);
    },
  );

  it("ignores notices for other profiles, malformed ones and any while unbound", async () => {
    const { reconciler, reads, bound } = harness();
    await bound({ profileId: 1, version: 5 });
    expect(reconciler.notify({ profileId: 2, version: 9 })).toBeNull();
    expect(reconciler.notify({ profileId: 1, version: Number.NaN })).toBeNull();
    expect(reconciler.notify({ profileId: 0, version: 9 })).toBeNull();
    expect(reconciler.notify({ profileId: 1, version: -1 })).toBeNull();
    await bound(null);
    expect(reconciler.notify({ profileId: 1, version: 9 })).toBeNull();
    expect(reads).toHaveLength(2);
  });

  it("keeps a notice for the profile a read in flight finds the device bound to", async () => {
    const { reconciler, read, bound } = harness();
    await bound({ profileId: 1, version: 5 });
    const done = reconciler.reconcile();
    const rebinding = await read(2);
    reconciler.notify({ profileId: 2, version: 4 });
    rebinding.resolve({ profileId: 2, version: 3 });
    (await read(3)).resolve({ profileId: 2, version: 4 });
    await done;
    // The notice for the profile it left is now irrelevant.
    expect(reconciler.notify({ profileId: 1, version: 6 })).toBeNull();
  });

  it("retries a notice whose read failed when it is announced again", async () => {
    const { reconciler, reads, read, errors, bound } = harness();
    await bound({ profileId: 1, version: 5 });
    const failed = reconciler.notify({ profileId: 1, version: 6 });
    (await read(2)).reject(new Error("offline"));
    await failed;
    expect(errors).toHaveLength(1);

    const retried = reconciler.notify({ profileId: 1, version: 6 });
    expect(retried).not.toBeNull();
    (await read(3)).resolve({ profileId: 1, version: 6 });
    await retried;
    expect(reconciler.notify({ profileId: 1, version: 6 })).toBeNull();
    expect(reads).toHaveLength(3);
  });

  it("stops after reads that stay behind a notice and catches up on the next trigger", async () => {
    const { reconciler, reads, read, bound } = harness();
    await bound({ profileId: 1, version: 5 });
    const done = reconciler.notify({ profileId: 1, version: 9 });
    for (const count of [2, 3, 4]) (await read(count)).resolve({ profileId: 1, version: 5 });
    await done;
    expect(reads).toHaveLength(4);
    // The recovery check, a reconnect or the foreground trigger reads again.
    const recovered = reconciler.reconcile();
    (await read(5)).resolve({ profileId: 1, version: 9 });
    await recovered;
    expect(reads).toHaveLength(5);
  });

  it("drops a read the local scope switch made obsolete and reads for the new scope", async () => {
    const { local, reconciler, read } = harness();
    const done = reconciler.reconcile();
    const old = await read(1);
    reconciler.notify({ profileId: 1, version: 7 });
    local.scope = "orbit:other-gateway";
    expect(old.isCurrent()).toBe(false);
    old.resolve({ profileId: 1, version: 7 });
    const fresh = await read(2);
    expect(fresh.isCurrent()).toBe(true);
    fresh.resolve({ profileId: 3, version: 1 });
    await done;
    // The old scope's notices and binding are gone.
    expect(reconciler.notify({ profileId: 1, version: 8 })).toBeNull();
  });

  it("drops work from before an invalidation even when the scope comes back the same", async () => {
    const { reconciler, read, reads } = harness();
    const done = reconciler.reconcile();
    const old = await read(1);
    reconciler.invalidate();
    expect(old.isCurrent()).toBe(false);
    old.resolve({ profileId: 1, version: 5 });
    (await read(2)).resolve({ profileId: 1, version: 6 });
    await done;
    expect(reads).toHaveLength(2);
    expect(reconciler.notify({ profileId: 1, version: 6 })).toBeNull();
  });

  it("ignores a refresh error from the previous scope", async () => {
    const { local, reconciler, read, errors } = harness();
    const done = reconciler.reconcile();
    const old = await read(1);
    local.scope = "orbit:other-gateway";
    old.reject(new Error("previous Gateway"));
    (await read(2)).resolve({ profileId: 1, version: 6 });
    await done;
    expect(errors).toEqual([]);
  });

  it("does nothing while profile sync is off or after dispose", async () => {
    const { local, reconciler, reads, read } = harness();
    local.scope = null;
    expect(reconciler.notify({ profileId: 1, version: 6 })).toBeNull();
    await reconciler.reconcile();
    expect(reads).toHaveLength(0);

    local.scope = "orbit:gateway";
    const done = reconciler.reconcile();
    const inFlight = await read(1);
    reconciler.dispose();
    expect(inFlight.isCurrent()).toBe(false);
    inFlight.resolve({ profileId: 1, version: 5 });
    await done;
    expect(reconciler.notify({ profileId: 1, version: 6 })).toBeNull();
    expect(reads).toHaveLength(1);
  });
});
