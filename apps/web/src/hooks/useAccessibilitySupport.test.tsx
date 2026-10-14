// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ClientSettings } from "@t3tools/contracts/settings";

const settings = vi.hoisted(() => ({
  accessibilitySupport: "auto" as ClientSettings["accessibilitySupport"],
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (value: typeof settings) => unknown) => select(settings),
}));
import { resolveAccessibilitySupport, useAccessibilitySupport } from "./useAccessibilitySupport";

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  delete window.desktopBridge;
  document.body.replaceChildren();
});

describe("accessible mode", () => {
  it.each([
    ["auto", false, false],
    ["auto", true, true],
    ["on", false, true],
    ["on", true, true],
    ["off", false, false],
    ["off", true, false],
  ] as const)("resolves %s with detected=%s to %s", (mode, detected, expected) => {
    expect(resolveAccessibilitySupport(mode, detected)).toBe(expected);
  });

  it("reacts immediately to native changes and manual overrides, ignoring a stale initial read", async () => {
    let publish: ((value: boolean) => void) | undefined;
    let resolveInitial: ((value: boolean) => void) | undefined;
    const stop = vi.fn();
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        getAccessibilitySupport: () =>
          new Promise<boolean>((resolve) => {
            resolveInitial = resolve;
          }),
        onAccessibilitySupportChanged: (listener: (value: boolean) => void) => {
          publish = listener;
          return stop;
        },
      },
    });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    function Status() {
      return <output>{useAccessibilitySupport() ? "On" : "Off"}</output>;
    }
    settings.accessibilitySupport = "auto";
    await act(async () => root!.render(<Status />));
    await act(async () => publish?.(true));
    expect(host.textContent).toBe("On");
    await act(async () => resolveInitial?.(false));
    expect(host.textContent).toBe("On");
    settings.accessibilitySupport = "off";
    await act(async () => root!.render(<Status />));
    expect(host.textContent).toBe("Off");
    settings.accessibilitySupport = "on";
    await act(async () => {
      publish?.(false);
      root!.render(<Status />);
    });
    expect(host.textContent).toBe("On");
    await act(async () => root!.unmount());
    root = undefined;
    expect(stop).toHaveBeenCalledOnce();
  });
});
