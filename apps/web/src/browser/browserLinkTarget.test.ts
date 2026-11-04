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
});
