import { describe, expect, it } from "vite-plus/test";

import { resolveLinkTarget } from "./browserLinkTarget";

const click = { metaKey: false, ctrlKey: false };

describe("resolveLinkTarget", () => {
  it("keeps the system browser unless the user asked for in-app", () => {
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: click,
        preference: "system",
        canOpenInApp: true,
      }),
    ).toBe("system");
  });

  it("opens in-app when asked and the runtime can", () => {
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: click,
        preference: "app",
        canOpenInApp: true,
      }),
    ).toBe("app");
  });

  it("falls back to the system browser where there is no in-app browser", () => {
    // The hosted web app and mobile have nowhere to open a tab, so the
    // preference cannot be honoured there and the link still has to open.
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: click,
        preference: "app",
        canOpenInApp: false,
      }),
    ).toBe("system");
  });

  it("treats a modifier click as the way out of the in-app default", () => {
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: { metaKey: true, ctrlKey: false },
        preference: "app",
        canOpenInApp: true,
      }),
    ).toBe("system");
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: { metaKey: false, ctrlKey: true },
        preference: "app",
        canOpenInApp: true,
      }),
    ).toBe("system");
  });

  it("leaves non-web schemes to the shell", () => {
    for (const url of ["mailto:someone@example.com", "vscode://file/x", "not a url"]) {
      expect(resolveLinkTarget({ url, event: click, preference: "app", canOpenInApp: true })).toBe(
        "system",
      );
    }
  });
});
