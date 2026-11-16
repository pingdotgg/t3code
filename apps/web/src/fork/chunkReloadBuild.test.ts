import { expect, it, vi } from "vite-plus/test";

import { reloadOnceForChunkLoadError } from "../lib/chunkReloadGuard";

const BUILD_A = "/assets/index-DAJCASuf.js";
const BUILD_B = "/assets/index-CvqH_BrO.js";
const BUILD_C = "/assets/index-D87gBQ2i.js";

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function failChunkOnPage(
  moduleScriptsInDocumentOrder: ReadonlyArray<string>,
  storage: Storage,
  reload: () => void,
) {
  const scripts = moduleScriptsInDocumentOrder.map((src) => ({ getAttribute: () => src }));
  vi.stubGlobal("document", { querySelectorAll: () => scripts });
  try {
    return reloadOnceForChunkLoadError(() => storage, reload);
  } finally {
    vi.unstubAllGlobals();
  }
}

it("reloads once per deployed build while the app version stays the same", () => {
  const storage = createStorage();
  const reload = vi.fn().mockName("location.reload");

  for (const build of [BUILD_A, BUILD_B, BUILD_C]) {
    expect(failChunkOnPage([build], storage, reload), `first failure on ${build}`).toBe(true);
    expect(failChunkOnPage([build], storage, reload), `repeat failure on ${build}`).toBe(false);
  }
  expect(reload).toHaveBeenCalledTimes(3);
});

it("keys on the build's own entry, so a script that changes on every load cannot loop", () => {
  const storage = createStorage();
  const reload = vi.fn().mockName("location.reload");

  const page = (load: number) => [`blob:https://t3.example/${load}`, `${BUILD_A}?load=${load}`];
  expect(failChunkOnPage(page(1), storage, reload)).toBe(true);
  expect(failChunkOnPage(page(2), storage, reload)).toBe(false);
  expect(reload).toHaveBeenCalledTimes(1);
});
