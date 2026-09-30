import { describe, expect, it } from "vite-plus/test";

import {
  getOrCreatePreviewAutomationHostId,
  resolvePreviewAutomationHostMetadata,
  resolvePreviewAutomationHostPlatform,
} from "./previewAutomationClientId";

const fixedCrypto = (byte: number): Crypto =>
  ({
    getRandomValues: (values: Uint8Array) => {
      values.fill(byte);
      return values;
    },
  }) as Crypto;

describe("preview automation host identity", () => {
  it("persists one stable id for every environment hosted by the desktop profile", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    const first = getOrCreatePreviewAutomationHostId(storage, fixedCrypto(1));
    const second = getOrCreatePreviewAutomationHostId(storage, fixedCrypto(2));

    expect(first).toBe("preview-01010101010101010101010101010101");
    expect(second).toBe(first);
  });

  it("keeps separate profiles unambiguous on the same operating system", () => {
    const makeStorage = () => {
      const values = new Map<string, string>();
      return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      };
    };

    expect(getOrCreatePreviewAutomationHostId(makeStorage(), fixedCrypto(1))).not.toBe(
      getOrCreatePreviewAutomationHostId(makeStorage(), fixedCrypto(2)),
    );
  });

  it("reuses one renderer-lifetime fallback after storage recovers", () => {
    let storageUnavailable = true;
    const recoveredStorage = {
      getItem: () => {
        if (storageUnavailable) throw new Error("storage unavailable");
        return null;
      },
      setItem: () => undefined,
    };

    const first = getOrCreatePreviewAutomationHostId(recoveredStorage, fixedCrypto(3));
    storageUnavailable = false;
    const second = getOrCreatePreviewAutomationHostId(recoveredStorage, fixedCrypto(4));

    expect(second).toBe(first);
  });

  it("reports native labels and derives a bounded fallback without OS-only identity", () => {
    expect(resolvePreviewAutomationHostPlatform("MacIntel")).toBe("macos");
    expect(resolvePreviewAutomationHostPlatform("Win32")).toBe("windows");
    expect(
      resolvePreviewAutomationHostMetadata(
        { label: "MacBook Pro", platform: "macos" },
        "Win32",
        "preview-aaaaaaaaaaaaaaaaaaaaaaaa12345678",
      ),
    ).toEqual({ label: "MacBook Pro", platform: "macos" });
    expect(
      resolvePreviewAutomationHostMetadata(
        null,
        "Win32",
        "preview-aaaaaaaaaaaaaaaaaaaaaaaa12345678",
      ),
    ).toEqual({ label: "Windows (12345678)", platform: "windows" });
    expect(
      resolvePreviewAutomationHostMetadata(
        { label: 42, platform: "invalid" } as never,
        "Win32",
        "preview-aaaaaaaaaaaaaaaaaaaaaaaa12345678",
      ),
    ).toEqual({ label: "Windows (12345678)", platform: "windows" });
  });
});
