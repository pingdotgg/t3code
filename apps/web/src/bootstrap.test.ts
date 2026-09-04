import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { showBootError } from "./lib/bootError";

class BootElement extends EventTarget {
  children: BootElement[] = [];
  textContent = "";

  constructor(readonly tagName: string) {
    super();
  }

  setAttribute() {}

  append(child: BootElement) {
    this.children.push(child);
  }

  replaceChildren(...children: BootElement[]) {
    this.children = children;
  }

  get text(): string {
    return this.textContent + this.children.map((child) => child.text).join(" ");
  }
}

describe("app startup failures", () => {
  let bootShell: BootElement | null;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("./main", () => {
      throw new Error("@vitejs/plugin-react can't detect preamble. Something is wrong.");
    });
    bootShell = new BootElement("div");
    vi.stubGlobal("document", {
      getElementById: () => bootShell,
      createElement: (tagName: string) => new BootElement(tagName),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("shows failures from asynchronous app startup", async () => {
    vi.doMock("./main", () => ({ startup: Promise.reject(new Error("Startup chunks failed")) }));

    await import("./bootstrap");
    await vi.dynamicImportSettled();

    expect(bootShell?.text).toContain("Startup chunks failed");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("replaces the splash when an app import throws before main can run", async () => {
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });

    await import("./bootstrap");
    await vi.dynamicImportSettled();

    expect(bootShell?.text).toContain("T3 Code could not load.");
    const reloadButton = bootShell?.children[0]?.children.find(
      (element) => element.tagName === "button",
    );
    expect(reloadButton?.text).toBe("Reload");
    reloadButton?.dispatchEvent(new Event("click"));
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each([true, false])("shows startup error details only in dev mode, DEV=%s", (dev) => {
    vi.stubEnv("DEV", dev);

    showBootError(new Error("internal module path"));

    expect(bootShell?.text).toContain("T3 Code could not load.");
    expect(bootShell?.text.includes("internal module path")).toBe(dev);
  });

  it("does not replace the app after React removes the splash", () => {
    bootShell = null;
    const createElement = vi.spyOn(document, "createElement");

    showBootError(new Error("late failure"));

    expect(createElement).not.toHaveBeenCalled();
  });
});
