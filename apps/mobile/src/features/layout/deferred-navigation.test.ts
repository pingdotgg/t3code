import { describe, expect, it } from "vite-plus/test";
import { createDeferredNavigation } from "./deferred-navigation";

describe("workspace mutation navigation", () => {
  it("keeps only the latest selection until all checkouts settle", async () => {
    const navigation = createDeferredNavigation();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const selected: string[] = [];
    navigation.waitFor(first.promise);
    navigation.waitFor(second.promise);
    navigation.run(() => selected.push("old draft"));
    navigation.run(() => selected.push("latest draft"));
    first.resolve();
    await first.promise;
    expect(selected).toEqual([]);
    second.resolve();
    await second.promise;
    expect(selected).toEqual(["latest draft"]);
    navigation.run(() => selected.push("thread"));
    expect(selected).toEqual(["latest draft", "thread"]);
  });

  it("waits for the removal guard commit after checkout completes", async () => {
    const navigation = createDeferredNavigation();
    const checkout = Promise.withResolvers<void>();
    const guardCommit = Promise.withResolvers<void>();
    let selected = false;
    const ready = Promise.allSettled([checkout.promise, guardCommit.promise]);
    navigation.waitFor(ready);
    navigation.run(() => {
      selected = true;
    });
    checkout.resolve();
    await checkout.promise;
    expect(selected).toBe(false);
    guardCommit.resolve();
    await ready;
    expect(selected).toBe(true);
  });

  it("releases selection after a failed checkout", async () => {
    const navigation = createDeferredNavigation();
    const checkout = Promise.withResolvers<void>();
    let selected = false;
    navigation.waitFor(checkout.promise);
    navigation.run(() => {
      selected = true;
    });
    checkout.reject(new Error("Checkout failed"));
    await checkout.promise.catch(() => undefined);
    expect(selected).toBe(true);
  });
});
