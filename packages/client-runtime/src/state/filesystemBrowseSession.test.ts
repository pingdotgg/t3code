import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { createFilesystemBrowseSession } from "./filesystem.ts";
import { executeAtomQuery } from "./runtime.ts";

describe("filesystem browse sessions", () => {
  const registries: AtomRegistry.AtomRegistry[] = [];
  const makeRegistry = () => {
    const registry = AtomRegistry.make();
    registries.push(registry);
    return registry;
  };
  afterEach(() => {
    for (const registry of registries.splice(0)) registry.dispose();
    vi.useRealTimers();
  });

  const cachedQuery = <A, E>(effect: Effect.Effect<A, E>) =>
    Atom.make(effect).pipe(
      Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
    );

  it("refreshes a warm listing when the picker reopens, even immediately", () => {
    const registry = makeRegistry();
    let entries = ["existing"];
    const request = vi.fn(() => entries);
    const source = cachedQuery(Effect.sync(request));
    const first = createFilesystemBrowseSession(() => source)(undefined);
    const close = registry.mount(first);
    expect(registry.get(first)).toMatchObject({ _tag: "Success", value: ["existing"] });
    close();

    entries = ["existing", "new-folder"];
    // Re-reading the shared query alone reproduces the stale idle-TTL listing.
    expect(registry.get(source)).toMatchObject({ value: ["existing"] });
    expect(request).toHaveBeenCalledTimes(1);
    const reopened = createFilesystemBrowseSession(() => source)(undefined);
    expect(registry.get(reopened)).toMatchObject({ _tag: "Success", value: entries });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fetches once on a cold open and reuses a navigation preload after a delayed mount", async () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    const request = vi.fn((path: string) => [path]);
    const family = Atom.family((path: string) => cachedQuery(Effect.sync(() => request(path))));
    const browse = createFilesystemBrowseSession(family);
    const close = registry.mount(browse("/"));
    expect(registry.get(browse("/"))).toMatchObject({ value: ["/"] });

    await executeAtomQuery(registry, browse("/next/"));
    await vi.advanceTimersByTimeAsync(2_000);
    const stop = registry.mount(browse("/next/"));
    expect(registry.get(browse("/next/"))).toMatchObject({ value: ["/next/"] });
    expect(request.mock.calls).toEqual([["/"], ["/next/"]]);
    close();
    stop();
  });

  it("retries a cached failure once on reopen", async () => {
    const registry = makeRegistry();
    let attempts = 0;
    const source = cachedQuery(
      Effect.suspend(() =>
        ++attempts === 1 ? Effect.fail("temporarily unavailable") : Effect.succeed(["folder"]),
      ),
    );
    expect(AsyncResult.isFailure(registry.get(source))).toBe(true);
    const browse = createFilesystemBrowseSession(() => source);
    expect(await executeAtomQuery(registry, browse(undefined))).toMatchObject({
      _tag: "Success",
      value: ["folder"],
    });
    expect(attempts).toBe(2);
  });

  it("shares an in-flight request when a second picker opens", async () => {
    const registry = makeRegistry();
    const pending = Promise.withResolvers<string[]>();
    const request = vi.fn(() => pending.promise);
    const source = cachedQuery(Effect.promise(request));
    const first = createFilesystemBrowseSession(() => source)(undefined);
    const second = createFilesystemBrowseSession(() => source)(undefined);
    const firstResult = executeAtomQuery(registry, first);
    const secondResult = executeAtomQuery(registry, second);
    expect(request).toHaveBeenCalledTimes(1);
    pending.resolve(["folder"]);
    for (const result of await Promise.all([firstResult, secondResult])) {
      expect(result).toMatchObject({ _tag: "Success", value: ["folder"] });
    }
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps the old listing visible while the reopened picker waits for fresh data", async () => {
    const registry = makeRegistry();
    const pending = Promise.withResolvers<string[]>();
    let attempts = 0;
    const source = cachedQuery(
      Effect.suspend(() =>
        ++attempts === 1 ? Effect.succeed(["existing"]) : Effect.promise(() => pending.promise),
      ),
    );
    expect(registry.get(source)).toMatchObject({ value: ["existing"] });
    const reopened = createFilesystemBrowseSession(() => source)(undefined);
    const result = executeAtomQuery(registry, reopened);
    expect(registry.get(reopened)).toMatchObject({ value: ["existing"], waiting: true });
    pending.resolve(["existing", "new-folder"]);
    expect(await result).toMatchObject({ value: ["existing", "new-folder"], waiting: false });
    expect(attempts).toBe(2);
  });

  it("keeps listings for different environments and paths separate", () => {
    const registry = makeRegistry();
    const request = vi.fn((key: string) => [key]);
    const family = Atom.family((key: string) => cachedQuery(Effect.sync(() => request(key))));
    const browse = createFilesystemBrowseSession((target: { environment: string; path: string }) =>
      family(JSON.stringify(target)),
    );
    for (const target of [
      { environment: "local", path: "/" },
      { environment: "remote", path: "/" },
      { environment: "remote", path: "/other/" },
    ]) {
      expect(registry.get(browse(target))).toMatchObject({ value: [JSON.stringify(target)] });
      expect(browse({ ...target })).toBe(browse(target));
    }
    expect(request).toHaveBeenCalledTimes(3);
  });
});
