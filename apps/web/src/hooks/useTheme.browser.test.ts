import { describe, expect, it, vi } from "vite-plus/test";

import { getThemeSnapshot, refreshTheme, setTheme } from "./useTheme";

describe("desktop window background", () => {
  it("sends the background again after the desktop app failed to take it, though the theme is unchanged", async () => {
    const storedKeys = new Set(Object.keys(window.localStorage));
    using _storage = {
      [Symbol.dispose]: () => {
        for (const key of Object.keys(window.localStorage)) {
          if (!storedKeys.has(key)) window.localStorage.removeItem(key);
        }
      },
    };
    const setWindowBackground = vi
      .fn<(background: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("The window is closing."))
      .mockResolvedValue(undefined);
    using _bridge = {
      [Symbol.dispose]: () => {
        delete window.desktopBridge;
      },
    };
    window.desktopBridge = { setTheme: async () => {}, setWindowBackground } as never;
    using _logged = vi.spyOn(console, "error").mockImplementation(() => {});

    refreshTheme();
    expect(setWindowBackground).toHaveBeenCalledTimes(1);
    await setWindowBackground.mock.results[0]?.value.catch(() => {});
    setTheme(getThemeSnapshot().theme);

    expect(setWindowBackground).toHaveBeenCalledTimes(2);
    expect(setWindowBackground.mock.calls[1]).toEqual(setWindowBackground.mock.calls[0]);
  });
});
