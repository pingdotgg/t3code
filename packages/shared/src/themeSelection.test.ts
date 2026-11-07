import { expect, it } from "vite-plus/test";
import { themeSelectionStorage, THEME_SELECTION_STORAGE_KEY } from "./themeSelection.ts";

it("migrates a device selection without losing missing environment themes or legacy data", () => {
  const data = new Map([
    ["t3code:theme", "offline-theme"],
    ["t3code:theme-halves:v1", '{"dark":"late-theme"}'],
  ]);
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  const selection = themeSelectionStorage(storage);
  selection.setItem("t3code:theme-appearance-mode", "system");
  expect(selection.getItem("t3code:theme")).toBe("offline-theme");
  expect(selection.getItem("t3code:theme-halves:v1")).toBe('{"dark":"late-theme"}');
  expect(data.get("t3code:theme")).toBe("offline-theme");
  selection.removeItem("t3code:theme-halves:v1");
  expect(selection.getItem("t3code:theme-halves:v1")).toBeNull();
  const saved = data.get(THEME_SELECTION_STORAGE_KEY);
  const failing = themeSelectionStorage({
    ...storage,
    setItem: () => {
      throw new Error("disk full");
    },
  });
  expect(() => failing.setItem("t3code:theme", "ocean")).toThrow("disk full");
  expect(data.get(THEME_SELECTION_STORAGE_KEY)).toBe(saved);
});

it("repairs a malformed selection on an explicit write while retaining legacy preferences", () => {
  for (const malformed of ["{", '{"version":1,"selection":false}']) {
    const data = new Map([
      [THEME_SELECTION_STORAGE_KEY, malformed],
      ["t3code:theme", "offline-theme"],
    ]);
    const selection = themeSelectionStorage({
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    });
    selection.setItem("t3code:theme-appearance-mode", "dark");
    expect(selection.getItem("t3code:theme")).toBe("offline-theme");
    expect(selection.getItem("t3code:theme-appearance-mode")).toBe("dark");
  }
});
