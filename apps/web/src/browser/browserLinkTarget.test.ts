import type { BrowserLinkTarget } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveLinkTarget } from "./browserLinkTarget";

const settings = vi.hoisted(() => ({ browserLinkTarget: "system" as BrowserLinkTarget }));

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
  getClientSettings: () => settings,
}));

const click = { metaKey: false, ctrlKey: false };

describe("resolveLinkTarget", () => {
  it("leaves non-web schemes to the shell", () => {
    for (const url of ["mailto:someone@example.com", "vscode://file/x", "not a url"]) {
      expect(resolveLinkTarget({ url, event: click, preference: "app", canOpenInApp: true })).toBe(
        "system",
      );
    }
  });

  it("sends the host's loopback links to its browser unless the click asks for the system one", () => {
    const url = "http://127.0.0.1:5173/";
    const input = { url, preference: "system", opensInEnvironmentBrowser: true } as const;
    expect(resolveLinkTarget({ ...input, event: click, canOpenInApp: true })).toBe("app");
    expect(
      resolveLinkTarget({ ...input, event: { ...click, metaKey: true }, canOpenInApp: true }),
    ).toBe("system");
    expect(resolveLinkTarget({ ...input, event: click, canOpenInApp: false })).toBe("system");
  });
});
