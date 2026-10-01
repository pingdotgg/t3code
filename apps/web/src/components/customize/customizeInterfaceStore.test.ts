import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  type InterfaceLayout,
} from "@t3tools/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const persisted = vi.hoisted(() => ({
  load: (): Promise<Partial<ClientSettings> | null> => Promise.resolve(null),
}));

vi.mock("~/localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/localApi")>()),
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: () => persisted.load(),
      setClientSettings: async () => undefined,
    },
  }),
}));

import { THEME_PREFERENCE_STORAGE_KEY } from "../../hooks/useTheme";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
  persistClientSettingsPatch,
} from "../../hooks/useSettings";
import { CUSTOMIZE_HISTORY_LIMIT, useCustomizeInterfaceStore } from "./customizeInterfaceStore";
import { createCustomizeActions, customizeActionsSettled } from "./useCustomizeActions";

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

const refreshTheme = vi.fn();
let writes: Array<Promise<void>> = [];
let persist = async (): Promise<void> => undefined;
const actions = createCustomizeActions({
  updateSettings: (patch) => {
    const write = persistClientSettingsPatch(patch, () => persist());
    writes.push(write);
    return write;
  },
  refreshTheme,
});
/** Waits for queued actions and every settings write they made. */
async function settled() {
  await customizeActionsSettled();
  await Promise.all(writes);
}
/**
 * Lets every queued microtask run, so actions that are free to run have run.
 * Actions held back on purpose stay held; this is a drain, not a timeout.
 */
function drainMicrotasks() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
function stall() {
  let release = () => {};
  const stalled = new Promise<void>((done) => {
    release = done;
  });
  return { stalled, release };
}
/**
 * Holds the queue the way a slow startup does: one write still saving and
 * another waiting behind it, so new writes defer instead of publishing.
 * Resolves once that state is reached, with a way to let the save finish.
 */
async function blockStartupWrites() {
  __resetClientSettingsPersistenceForTests();
  persisted.load = () => Promise.resolve(null);
  let release = () => {};
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  let saving = () => {};
  const startupSaving = new Promise<void>((done) => {
    saving = done;
  });
  writes.push(
    persistClientSettingsPatch({ fontFamilySans: "Inter" }, () => {
      saving();
      return blocked;
    }),
    persistClientSettingsPatch({ fontFamilyCode: "Mono" }, async () => undefined),
  );
  await startupSaving;
  return release;
}
function deferHydration() {
  __resetClientSettingsPersistenceForTests();
  let resolve: (settings: Partial<ClientSettings>) => void = () => {};
  const loaded = new Promise<Partial<ClientSettings>>((done) => {
    resolve = done;
  });
  persisted.load = () => loaded;
  return resolve;
}
const hide =
  (id: string) =>
  (layout: InterfaceLayout): InterfaceLayout => ({
    ...layout,
    threadRow: { order: [], hidden: [...(layout.threadRow?.hidden ?? []), id] },
  });
const store = () => useCustomizeInterfaceStore.getState();
const theme = () => window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY);
const setTheme = (value: string) =>
  window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, value);

beforeEach(() => {
  const localStorage = createLocalStorageStub();
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("localStorage", localStorage);
  vi.useFakeTimers({ toFake: ["Date"] });
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  refreshTheme.mockClear();
  writes = [];
  persist = async () => undefined;
  store().close();
  store().open();
});

afterEach(() => {
  store().close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Customize interface history", () => {
  it("records what a change replaced and undoes it", async () => {
    actions.commit({ chatWidth: "wide" });
    await customizeActionsSettled();
    expect(getClientSettings().chatWidth).toBe("wide");
    expect(store().history).toEqual([{ settings: { chatWidth: "comfortable" }, theme: {} }]);

    actions.undo();
    await customizeActionsSettled();
    expect(getClientSettings().chatWidth).toBe("comfortable");
    expect(store().history).toEqual([]);
  });

  it("coalesces rapid changes to one key into a single step", async () => {
    actions.commit({ fontFamilySans: "A" }, "font");
    vi.advanceTimersByTime(300);
    actions.commit({ fontFamilySans: "B" }, "font");
    vi.advanceTimersByTime(300);
    actions.commit({ fontFamilySans: "C" }, "font");
    await customizeActionsSettled();
    expect(store().history).toHaveLength(1);

    vi.advanceTimersByTime(2000);
    actions.commit({ fontFamilySans: "D" }, "font");
    await customizeActionsSettled();
    expect(store().history).toHaveLength(2);

    actions.undo();
    actions.undo();
    await customizeActionsSettled();
    expect(getClientSettings().fontFamilySans).toBe("");
  });

  it("records nothing for a change that changes nothing", async () => {
    actions.commit({ chatWidth: "comfortable" });
    actions.commitLayout((layout) => ({ ...layout }));
    setTheme("dark");
    actions.withRecord(() => setTheme("dark"), "theme");
    await customizeActionsSettled();
    expect(store().history).toEqual([]);
  });

  it("records only the theme keys a theme change wrote", async () => {
    setTheme("light");
    actions.withRecord(() => setTheme("dark"), "theme");
    await customizeActionsSettled();
    expect(store().history).toEqual([
      { settings: {}, theme: { [THEME_PREFERENCE_STORAGE_KEY]: "light" } },
    ]);

    actions.undo();
    await customizeActionsSettled();
    expect(theme()).toBe("light");
    expect(refreshTheme).toHaveBeenCalledTimes(1);
  });

  it("makes Revert undoable", async () => {
    actions.commit({ chatWidth: "wide" });
    actions.withRecord(() => setTheme("dark"));
    await customizeActionsSettled();

    actions.revert();
    await customizeActionsSettled();
    expect(getClientSettings().chatWidth).toBe("comfortable");
    expect(theme()).toBeNull();

    actions.undo();
    await customizeActionsSettled();
    expect(getClientSettings().chatWidth).toBe("wide");
    expect(theme()).toBe("dark");
  });

  it("leaves settings and themes changed elsewhere alone on Undo and Revert", async () => {
    setTheme("light");
    actions.commit({ chatWidth: "wide" });
    await customizeActionsSettled();
    // Settings, or a server-side theme change, while the mode is open.
    await persistClientSettingsPatch({ fontFamilySans: "Inter" }, async () => undefined);
    setTheme("published-theme");

    actions.commit({ chatWidth: "full" });
    actions.undo();
    actions.revert();
    await customizeActionsSettled();
    expect(getClientSettings().chatWidth).toBe("comfortable");
    expect(getClientSettings().fontFamilySans).toBe("Inter");
    expect(theme()).toBe("published-theme");
    expect(refreshTheme).not.toHaveBeenCalled();
  });

  it("caps history, but Revert still reaches the first value", async () => {
    for (let index = 0; index <= CUSTOMIZE_HISTORY_LIMIT; index += 1) {
      actions.commit({ fontFamilySans: `font-${index}` });
    }
    await customizeActionsSettled();
    expect(store().history).toHaveLength(CUSTOMIZE_HISTORY_LIMIT);
    expect(store().history[0]?.settings).toEqual({ fontFamilySans: "font-0" });

    actions.revert();
    await customizeActionsSettled();
    expect(getClientSettings().fontFamilySans).toBe("");
  });

  it("undoes to the saved value when used before settings hydrate", async () => {
    const resolve = deferHydration();

    actions.commit({ chatWidth: "wide" });
    actions.undo();
    resolve({ chatWidth: "full" });
    await customizeActionsSettled();
    expect(getClientSettings().chatWidth).toBe("full");
    expect(store().history).toEqual([]);
  });

  it("builds each edit on the last while settings writes are deferred", async () => {
    const release = await blockStartupWrites();

    actions.commitLayout(hide("terminal"));
    actions.commitLayout(hide("branch"));
    await drainMicrotasks();
    release();
    await settled();
    expect(getClientSettings().interfaceLayout.threadRow?.hidden).toEqual(["terminal", "branch"]);

    actions.undo();
    await settled();
    expect(getClientSettings().interfaceLayout.threadRow?.hidden).toEqual(["terminal"]);
  });

  it("does not bring back an undone edit while settings writes are deferred", async () => {
    const release = await blockStartupWrites();

    // The hide publishes, then its save stalls with the Undo queued behind it.
    const save = stall();
    let saving = () => {};
    const hideSaving = new Promise<void>((done) => {
      saving = done;
    });
    persist = () => {
      saving();
      return save.stalled;
    };
    actions.commitLayout(hide("terminal"));
    actions.undo();
    await drainMicrotasks();
    release();
    await hideSaving;

    actions.commitLayout(hide("branch"));
    await drainMicrotasks();
    save.release();
    await settled();
    expect(getClientSettings().interfaceLayout.threadRow?.hidden).toEqual(["branch"]);
  });

  it("drops settings changes while settings fail to load, then recovers", async () => {
    __resetClientSettingsPersistenceForTests();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    persisted.load = () => Promise.reject(new Error("unreadable"));

    actions.commit({ chatWidth: "wide" });
    await settled();
    expect(getClientSettings().chatWidth).toBe("comfortable");
    expect(store().history).toEqual([]);
    consoleError.mockRestore();

    persisted.load = () => Promise.resolve({ chatWidth: "full" });
    actions.commit({ chatWidth: "wide" });
    await settled();
    expect(getClientSettings().chatWidth).toBe("wide");

    actions.undo();
    await settled();
    expect(getClientSettings().chatWidth).toBe("full");
  });

  it("drops work queued in a session that has since closed", async () => {
    const resolve = deferHydration();

    actions.commit({ chatWidth: "wide" });
    store().close();
    store().open();
    resolve({});
    await settled();
    expect(getClientSettings().chatWidth).toBe("comfortable");
    expect(store().history).toEqual([]);
  });

  it("reads a value changed elsewhere after the mode's write publishes but stalls", async () => {
    const release = await blockStartupWrites();
    const save = stall();
    persist = () => save.stalled;
    actions.commit({ chatWidth: "wide" });
    await drainMicrotasks();
    release();
    await customizeActionsSettled();
    expect(getClientSettings().chatWidth).toBe("wide");

    store().close();
    // Settings publishes at once; its save queues behind the stalled one.
    writes.push(persistClientSettingsPatch({ chatWidth: "full" }, async () => undefined));
    store().open();
    actions.commit({ chatWidth: "comfortable" });
    await customizeActionsSettled();
    expect(store().history).toEqual([{ settings: { chatWidth: "full" }, theme: {} }]);

    actions.undo();
    await customizeActionsSettled();
    expect(getClientSettings().chatWidth).toBe("full");
    save.release();
    await settled();
  });
});
