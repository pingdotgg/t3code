import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  forceRefreshApp,
  shouldShowDownloadableDiagnostics,
  shouldShowOpenInPicker,
} from "./ChatHeader";

const originalWindow = globalThis.window;

function installWindowStub(input: {
  readonly href?: string;
  readonly forceReload?: () => Promise<void>;
  readonly reload?: () => void;
}) {
  const storage = new Map<string, string>();

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      ...(input.forceReload
        ? {
            desktopBridge: {
              forceReload: input.forceReload,
            },
          }
        : {}),
      location: {
        href: input.href ?? "https://example.com/",
        reload: input.reload ?? vi.fn(),
      },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => {
          storage.delete(key);
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});

describe("shouldShowDownloadableDiagnostics", () => {
  it("shows downloadable diagnostics when the server feature flag is present", () => {
    installWindowStub({});

    expect(
      shouldShowDownloadableDiagnostics({
        serverWebFeatureFlags: ["downloadable-diagnostics"],
      }),
    ).toBe(true);
  });

  it("shows downloadable diagnostics when the feature flag is present", () => {
    installWindowStub({ href: "https://example.com/?salchiFeature=downloadable-diagnostics" });

    expect(shouldShowDownloadableDiagnostics()).toBe(true);
  });

  it("hides downloadable diagnostics without the feature flag", () => {
    installWindowStub({});

    expect(shouldShowDownloadableDiagnostics()).toBe(false);
  });
});

describe("forceRefreshApp", () => {
  it("uses the desktop force reload bridge when available", () => {
    const forceReload = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn();
    installWindowStub({ forceReload, reload });

    forceRefreshApp();

    expect(forceReload).toHaveBeenCalledWith();
    expect(reload).not.toHaveBeenCalled();
  });

  it("falls back to browser reload without the desktop bridge", () => {
    const reload = vi.fn();
    installWindowStub({ reload });

    forceRefreshApp();

    expect(reload).toHaveBeenCalledWith();
  });

  it("falls back to browser reload when desktop force reload fails", async () => {
    const forceReload = vi.fn().mockRejectedValue(new Error("ipc failed"));
    const reload = vi.fn();
    installWindowStub({ forceReload, reload });

    forceRefreshApp();
    await Promise.resolve();

    expect(forceReload).toHaveBeenCalledWith();
    expect(reload).toHaveBeenCalledWith();
  });
});
