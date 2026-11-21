import { describe, expect, it } from "vite-plus/test";

import {
  externalLinkContextMenuItems,
  resolveExternalWebLinkHref,
} from "./externalLinkContextMenu";

describe("external chat link context menu", () => {
  it.each([
    [
      "https://example.com/docs?topic=security#links",
      "https://example.com/docs?topic=security#links",
    ],
    ["HTTP://EXAMPLE.COM", "http://example.com/"],
    ["//example.com/path", "https://example.com/path"],
  ])("resolves the safe external web-link href for %s as %s", (href, expected) => {
    expect(resolveExternalWebLinkHref(href)).toBe(expected);
  });

  it.each([
    "javascript:alert(document.domain)",
    " \nJaVaScRiPt:alert(document.domain)",
    "data:text/html,<script>alert(document.domain)</script>",
    "file:///tmp/example.txt",
    "mailto:hello@example.com",
    "/relative/path",
    "not a URL",
    "",
  ])("rejects unsafe external web-link href %s", (href) => {
    expect(resolveExternalWebLinkHref(href)).toBeNull();
  });

  it.each([
    [true, true, ["open-in-preview", "open-in-window", "open-external", "copy-link"]],
    [true, false, ["open-in-preview", "open-external", "copy-link"]],
    [false, true, ["open-external", "copy-link"]],
  ])("with preview %s and window %s offers %j", (canOpenInPreview, canOpenInWindow, ids) => {
    expect(
      externalLinkContextMenuItems({ canOpenInPreview, canOpenInWindow }).map((item) => item.id),
    ).toEqual(ids);
  });
});
