import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canUseMarkdownFileShellActions,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./ChatMarkdown";

describe("canUseMarkdownFileShellActions", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("allows editor and file manager actions only for resolved local environments", () => {
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", true)).toBe(true);
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", false)).toBe(false);
    expect(canUseMarkdownFileShellActions(environmentId, "remote-links", true)).toBe(false);
    expect(canUseMarkdownFileShellActions(environmentId, "remote-unavailable", true)).toBe(false);
    expect(canUseMarkdownFileShellActions(null, "local-exec", true)).toBe(false);
  });
});

describe("shouldUseMarkdownFileBrowserPrimaryAction", () => {
  const html = { iconPath: "/tmp/report.html", canOpenInBrowser: true };

  it("uses the browser only when it is the sole action, except for PDFs", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: false,
        canOpenInPanel: false,
      }),
    ).toBe(true);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: true,
        canOpenInPanel: false,
      }),
    ).toBe(false);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: false,
        canOpenInPanel: true,
      }),
    ).toBe(false);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.pdf",
        canOpenInEditor: true,
        canOpenInBrowser: true,
        canOpenInPanel: true,
      }),
    ).toBe(true);
  });
});
