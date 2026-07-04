import { describe, expect, it, vi } from "vitest";

import {
  createPackagedStartupLoadingUrl,
  navigatePackagedStartupWindow,
} from "./packagedStartupWindow.ts";

describe("packaged startup window", () => {
  it("provides a self-contained loading page before the backend is ready", () => {
    const url = createPackagedStartupLoadingUrl("T3 Code (Dev)");

    expect(url).toMatch(/^data:text\/html;charset=utf-8,/);
    expect(decodeURIComponent(url)).toContain("Starting T3 Code (Dev)");
  });

  it("navigates a live window to the backend after readiness", async () => {
    const loadURL = vi.fn<(_url: string) => Promise<void>>().mockResolvedValue(undefined);

    await navigatePackagedStartupWindow(
      {
        isDestroyed: () => false,
        loadURL,
      },
      "http://127.0.0.1:3773",
    );

    expect(loadURL).toHaveBeenCalledWith("http://127.0.0.1:3773");
  });

  it("does not navigate a window that closed during backend startup", async () => {
    const loadURL = vi.fn<(_url: string) => Promise<void>>().mockResolvedValue(undefined);

    await navigatePackagedStartupWindow(
      {
        isDestroyed: () => true,
        loadURL,
      },
      "http://127.0.0.1:3773",
    );

    expect(loadURL).not.toHaveBeenCalled();
  });
});
