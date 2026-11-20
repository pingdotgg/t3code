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

  it("resolves to app when preference is app, in-app opening is available, and url is web url", () => {
    expect(
      resolveLinkTarget({
        url: "https://github.com/owner/repo/pull/1",
        event: click,
        preference: "app",
        canOpenInApp: true,
      }),
    ).toBe("app");
  });

  it("resolves to system when preference is system", () => {
    expect(
      resolveLinkTarget({
        url: "https://github.com/owner/repo/pull/1",
        event: click,
        preference: "system",
        canOpenInApp: true,
      }),
    ).toBe("system");
  });

  it("resolves to system when modified with meta or ctrl or middle-clicked", () => {
    for (const event of [
      { metaKey: true, ctrlKey: false },
      { metaKey: false, ctrlKey: true },
      { metaKey: false, ctrlKey: false, button: 1 },
    ]) {
      expect(
        resolveLinkTarget({
          url: "https://github.com/owner/repo/pull/1",
          event,
          preference: "app",
          canOpenInApp: true,
        }),
      ).toBe("system");
    }
  });

  it("resolves to system when in-app opening is unavailable", () => {
    expect(
      resolveLinkTarget({
        url: "https://github.com/owner/repo/pull/1",
        event: click,
        preference: "app",
        canOpenInApp: false,
      }),
    ).toBe("system");
  });
});
