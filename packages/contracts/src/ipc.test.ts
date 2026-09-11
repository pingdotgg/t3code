import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema, DesktopPreviewAutomationStatusSchema } from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("DesktopPreviewAutomationStatusSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopPreviewAutomationStatusSchema);

  it("accepts composite runtime tab ids longer than public preview tab ids", () => {
    const tabId = JSON.stringify([
      "a129857b-712f-4955-bdd7-0749b327e98f",
      `worktree:00a4614b-a6de-41db-9e7e-0c03ce8b203b:${encodeURIComponent(
        "/Users/example/.t3/worktrees/repository/a-long-checkout-name-for-preview-automation",
      )}`,
      "8ede8f09-68f7-41ae-87e7-f226cea41a97",
      "tab_5",
    ]);
    const status = {
      available: true,
      visible: false,
      tabId,
      url: "https://example.com",
      title: "Example",
      loading: false,
    };

    expect(tabId.length).toBeGreaterThan(128);
    expect(decode(status)).toEqual(status);
  });
});
