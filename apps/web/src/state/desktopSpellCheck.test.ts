import type { DesktopSpellCheckState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createDesktopSpellCheckStore } from "./desktopSpellCheck";

const stateWith = (languages: string[]): DesktopSpellCheckState => ({
  availableLanguages: ["en-US", "fr", "it-IT"],
  languages,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Reply = ReturnType<typeof deferred<DesktopSpellCheckState | null>>;

/**
 * Changes reply when the test settles them, in any order. Reads answer with
 * what the desktop applied, unless the test holds them.
 */
async function loadedStore(applied: DesktopSpellCheckState) {
  const changes: Reply[] = [];
  const heldReads: Reply[] = [];
  let holdReads = false;
  const store = createDesktopSpellCheckStore(() => ({
    getSpellCheckState: () => {
      if (!holdReads) return Promise.resolve(applied);
      const reply: Reply = deferred();
      heldReads.push(reply);
      return reply.promise;
    },
    setSpellCheckLanguages: () => {
      const reply: Reply = deferred();
      changes.push(reply);
      return reply.promise;
    },
  }));
  await store.refresh();
  return {
    store,
    changes,
    heldReads,
    holdReads: () => {
      holdReads = true;
    },
  };
}

describe("desktop spell check store", () => {
  it("keeps the later selection when an earlier reply arrives last", async () => {
    const { store, changes } = await loadedStore(stateWith(["en-US"]));

    const first = store.setLanguages(["en-US", "fr"]);
    const second = store.setLanguages(["en-US", "it-IT"]);
    changes[1]!.resolve(stateWith(["en-US", "it-IT"]));
    await second;
    changes[0]!.resolve(stateWith(["en-US", "fr"]));
    await first;

    expect(store.getSnapshot()?.languages).toEqual(["en-US", "it-IT"]);
  });

  it("shows what the desktop applied when consecutive changes fail", async () => {
    const { store, changes } = await loadedStore(stateWith(["en-US"]));

    const first = store.setLanguages(["en-US", "fr"]);
    const second = store.setLanguages(["en-US", "it-IT"]);
    changes[0]!.reject(new Error("write failed"));
    changes[1]!.reject(new Error("write failed"));
    await expect(first).rejects.toThrow("write failed");
    await expect(second).rejects.toThrow("write failed");

    expect(store.getSnapshot()?.languages).toEqual(["en-US"]);
  });

  it("ignores a read that started before a change", async () => {
    const { store, changes, heldReads, holdReads } = await loadedStore(stateWith(["en-US"]));

    holdReads();
    const staleRead = store.refresh();
    const change = store.setLanguages(["fr"]);
    changes[0]!.resolve(stateWith(["fr"]));
    await change;
    heldReads[0]!.resolve(stateWith(["en-US"]));
    await staleRead;

    expect(store.getSnapshot()?.languages).toEqual(["fr"]);
  });

  it("ignores a read that starts while a change is pending", async () => {
    const { store, changes, heldReads, holdReads } = await loadedStore(stateWith(["en-US"]));

    const change = store.setLanguages(["it-IT"]);
    holdReads();
    const read = store.refresh();
    changes[0]!.resolve(stateWith(["it-IT"]));
    await change;
    heldReads[0]?.resolve(stateWith(["en-US"]));
    await read;

    expect(store.getSnapshot()?.languages).toEqual(["it-IT"]);
  });

  it("refuses an empty list, which Electron would treat as en-US", async () => {
    const { store, changes } = await loadedStore(stateWith(["fr"]));

    await store.setLanguages([]);

    expect(changes).toHaveLength(0);
    expect(store.getSnapshot()?.languages).toEqual(["fr"]);
  });
});
