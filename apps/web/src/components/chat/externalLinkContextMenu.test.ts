import { describe, expect, it, vi } from "vite-plus/test";

import {
  resolveExternalWebLinkHost,
  resolveExternalWebLinkHref,
  showExternalLinkContextMenu,
} from "./externalLinkContextMenu";

function createHarness(selection: "open-in-preview" | "open-external" | "copy-link" | null) {
  const showContextMenu = vi.fn().mockResolvedValue(selection);
  const openInPreview = vi.fn().mockResolvedValue(undefined);
  const openExternal = vi.fn().mockResolvedValue(undefined);
  const copyLink = vi.fn().mockResolvedValue(undefined);
  const reportFailure = vi.fn();

  return {
    showContextMenu,
    openInPreview,
    openExternal,
    copyLink,
    reportFailure,
  };
}

describe("external chat link context menu", () => {
  it("offers both open actions and Copy Link", async () => {
    const harness = createHarness(null);

    await showExternalLinkContextMenu({
      href: "https://example.com/docs?topic=menus#copy",
      position: { x: 12, y: 24 },
      ...harness,
    });

    expect(harness.showContextMenu).toHaveBeenCalledWith(
      [
        { id: "open-in-preview", label: "Open in integrated browser" },
        { id: "open-external", label: "Open in system browser" },
        { id: "copy-link", label: "Copy Link" },
      ],
      { x: 12, y: 24 },
    );
    expect(harness.openInPreview).not.toHaveBeenCalled();
    expect(harness.openExternal).not.toHaveBeenCalled();
    expect(harness.copyLink).not.toHaveBeenCalled();
  });

  it("still offers the link's own actions where the integrated browser cannot be opened", async () => {
    const harness = createHarness(null);

    await showExternalLinkContextMenu({
      href: "https://github.com/pingdotgg/t3code/pull/6169",
      canOpenInPreview: false,
      position: { x: 4, y: 8 },
      ...harness,
    });

    expect(harness.showContextMenu).toHaveBeenCalledWith(
      [
        { id: "open-external", label: "Open in system browser" },
        { id: "copy-link", label: "Copy Link" },
      ],
      { x: 4, y: 8 },
    );
  });

  it("copies the exact destination without opening it", async () => {
    const harness = createHarness("copy-link");
    const href = "https://example.com/docs?topic=menus#copy";

    await showExternalLinkContextMenu({ href, position: { x: 1, y: 2 }, ...harness });

    expect(harness.copyLink).toHaveBeenCalledWith(href);
    expect(harness.openInPreview).not.toHaveBeenCalled();
    expect(harness.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ["open-in-preview" as const, "openInPreview" as const],
    ["open-external" as const, "openExternal" as const],
  ])("preserves the %s action", async (selection, expectedCallback) => {
    const harness = createHarness(selection);
    const href = "https://example.com/docs";

    await showExternalLinkContextMenu({ href, position: { x: 1, y: 2 }, ...harness });

    expect(harness[expectedCallback]).toHaveBeenCalledWith(href);
    expect(harness.copyLink).not.toHaveBeenCalled();
  });

  it("reports the selected action when it fails", async () => {
    const harness = createHarness("copy-link");
    const cause = new Error("clipboard denied");
    harness.copyLink.mockRejectedValue(cause);

    await showExternalLinkContextMenu({
      href: "https://example.com/docs",
      position: { x: 1, y: 2 },
      ...harness,
    });

    expect(harness.reportFailure).toHaveBeenCalledWith("copy-link", cause);
  });

  it("reports the menu operation when the native menu cannot be shown", async () => {
    const harness = createHarness(null);
    const cause = new Error("menu unavailable");
    harness.showContextMenu.mockRejectedValue(cause);

    await showExternalLinkContextMenu({
      href: "https://example.com/docs",
      position: { x: 1, y: 2 },
      ...harness,
    });

    expect(harness.reportFailure).toHaveBeenCalledWith("show-link-context-menu", cause);
    expect(harness.openInPreview).not.toHaveBeenCalled();
    expect(harness.openExternal).not.toHaveBeenCalled();
    expect(harness.copyLink).not.toHaveBeenCalled();
  });

  it.each([
    ["open-in-preview" as const, "openInPreview" as const, "open-link-in-preview"],
    ["open-external" as const, "openExternal" as const, "open-link-external"],
  ])("reports a failed %s action", async (selection, callback, operation) => {
    const harness = createHarness(selection);
    const cause = new Error("open failed");
    harness[callback].mockRejectedValue(cause);

    await showExternalLinkContextMenu({
      href: "https://example.com/docs",
      position: { x: 1, y: 2 },
      ...harness,
    });

    expect(harness.reportFailure).toHaveBeenCalledWith(operation, cause);
  });

  it.each([
    ["https://example.com", "example.com"],
    ["http://localhost:3000/path", "localhost"],
    ["#details", null],
    ["mailto:hello@example.com", null],
    ["file:///tmp/example.txt", null],
    ["javascript:void(0)", null],
    ["not a URL", null],
    [undefined, null],
  ])("resolves the external web-link host for %s as %s", (href, expected) => {
    expect(resolveExternalWebLinkHost(href)).toBe(expected);
  });

  it.each([
    [
      "https://example.com/docs?topic=security#links",
      "https://example.com/docs?topic=security#links",
    ],
    ["HTTP://EXAMPLE.COM", "http://example.com/"],
  ])("resolves the safe external web-link href for %s as %s", (href, expected) => {
    expect(resolveExternalWebLinkHref(href)).toBe(expected);
  });

  it.each([
    "javascript:alert(document.domain)",
    " \nJaVaScRiPt:alert(document.domain)",
    "data:text/html,<script>alert(document.domain)</script>",
    "file:///tmp/example.txt",
    "mailto:hello@example.com",
    "//example.com/path",
    "/relative/path",
    "not a URL",
    "",
  ])("rejects unsafe external web-link href %s", (href) => {
    expect(resolveExternalWebLinkHref(href)).toBeNull();
  });
});
