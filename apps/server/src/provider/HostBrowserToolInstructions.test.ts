import { describe, expect, it } from "vite-plus/test";

import {
  HOST_BROWSER_TOOL_INSTRUCTIONS,
  prefixHostBrowserToolInstructions,
} from "./HostBrowserToolInstructions.ts";

describe("HOST_BROWSER_TOOL_INSTRUCTIONS", () => {
  it("steers browser work to the in-app preview and names Aside as an alternative", () => {
    expect(HOST_BROWSER_TOOL_INSTRUCTIONS).toContain("in-app browser");
    expect(HOST_BROWSER_TOOL_INSTRUCTIONS).toContain("collaborative browser");
    expect(HOST_BROWSER_TOOL_INSTRUCTIONS).toContain("preview_status");
    expect(HOST_BROWSER_TOOL_INSTRUCTIONS).toContain("Aside");
    expect(HOST_BROWSER_TOOL_INSTRUCTIONS).toContain("aside exec");
  });

  it("prefixes only when the preview tools are attached", () => {
    expect(prefixHostBrowserToolInstructions("open the app", { includeBrowserTools: false })).toBe(
      "open the app",
    );
    expect(
      prefixHostBrowserToolInstructions("open the app", { includeBrowserTools: true }),
    ).toContain("open the app");
    expect(
      prefixHostBrowserToolInstructions("open the app", { includeBrowserTools: true }),
    ).toContain(HOST_BROWSER_TOOL_INSTRUCTIONS.trim());
    expect(prefixHostBrowserToolInstructions("", { includeBrowserTools: true })).toBe(
      HOST_BROWSER_TOOL_INSTRUCTIONS.trim(),
    );
  });
});
