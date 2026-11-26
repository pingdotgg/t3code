import { describe, expect, it } from "vite-plus/test";

import {
  decideWorkspaceWebPreviewNavigation,
  shouldStartWorkspaceWebPreviewLoad,
} from "./workspaceFileWebPreviewPolicy";

const INITIAL_HTTPS_URI = "https://greendale.test/api/assets/token-1/report.html";
const INITIAL_FILE_URI = "file:///cache/greendale/report.html";

describe("shouldStartWorkspaceWebPreviewLoad", () => {
  it("allows the initial document and same-document fragment navigations", () => {
    expect(
      shouldStartWorkspaceWebPreviewLoad(
        { url: INITIAL_HTTPS_URI, isTopFrame: true },
        INITIAL_HTTPS_URI,
      ),
    ).toBe(true);
    expect(
      shouldStartWorkspaceWebPreviewLoad(
        { url: `${INITIAL_HTTPS_URI}#section-2`, isTopFrame: true },
        INITIAL_HTTPS_URI,
      ),
    ).toBe(true);
    expect(
      shouldStartWorkspaceWebPreviewLoad(
        { url: `${INITIAL_FILE_URI}#summary`, isTopFrame: true },
        INITIAL_FILE_URI,
      ),
    ).toBe(true);
  });

  it.each([
    "t3code://pair?token=secret",
    "t3code-dev://open",
    "tel:+15551234567",
    "sms:+15551234567",
    "mailto:troy@greendale.edu",
    "javascript:alert(1)",
    "intent://scan/#Intent;scheme=t3code;end",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
  ])("blocks non-HTTP(S) URI scheme %s in both top frames and subframes", (url) => {
    expect(
      decideWorkspaceWebPreviewNavigation(
        { url, isTopFrame: true, navigationType: "click" },
        INITIAL_HTTPS_URI,
      ),
    ).toEqual({ action: "block" });
    expect(
      shouldStartWorkspaceWebPreviewLoad(
        { url, isTopFrame: true, navigationType: "click" },
        INITIAL_HTTPS_URI,
      ),
    ).toBe(false);
    expect(shouldStartWorkspaceWebPreviewLoad({ url, isTopFrame: false }, INITIAL_HTTPS_URI)).toBe(
      false,
    );
  });

  it("blocks navigating a local file preview to a different file path", () => {
    expect(
      shouldStartWorkspaceWebPreviewLoad(
        { url: "file:///etc/passwd", isTopFrame: true },
        INITIAL_FILE_URI,
      ),
    ).toBe(false);
  });

  it("blocks cross-origin and non-click top-frame redirects", () => {
    expect(
      decideWorkspaceWebPreviewNavigation(
        { url: "https://evil.example/phish", isTopFrame: true, navigationType: "other" },
        INITIAL_HTTPS_URI,
      ),
    ).toEqual({ action: "block" });
    expect(
      shouldStartWorkspaceWebPreviewLoad(
        { url: "https://greendale.test/api/other", isTopFrame: true, navigationType: "other" },
        INITIAL_HTTPS_URI,
      ),
    ).toBe(false);
  });

  it("routes explicit user-clicked HTTP(S) links to external open instead of loading in-place", () => {
    expect(
      decideWorkspaceWebPreviewNavigation(
        { url: "https://example.com/docs", isTopFrame: true, navigationType: "click" },
        INITIAL_HTTPS_URI,
      ),
    ).toEqual({ action: "open-external", url: "https://example.com/docs" });
    expect(
      shouldStartWorkspaceWebPreviewLoad(
        { url: "https://example.com/docs", isTopFrame: true, navigationType: "click" },
        INITIAL_HTTPS_URI,
      ),
    ).toBe(false);
  });

  it("loads Android link taps, which carry no navigationType or isTopFrame, in place", () => {
    expect(
      decideWorkspaceWebPreviewNavigation({ url: "https://example.test/docs" }, INITIAL_HTTPS_URI),
    ).toEqual({ action: "allow" });
    expect(
      decideWorkspaceWebPreviewNavigation({ url: "t3code://settings" }, INITIAL_HTTPS_URI),
    ).toEqual({ action: "block" });
  });

  it("hands same-origin PDFs to the native PDF viewer and blocks cross-origin PDF redirects", () => {
    expect(
      decideWorkspaceWebPreviewNavigation(
        {
          url: "https://greendale.test/api/assets/token-1/syllabus.pdf#page=2",
          isTopFrame: true,
        },
        INITIAL_HTTPS_URI,
      ),
    ).toEqual({
      action: "open-pdf",
      url: "https://greendale.test/api/assets/token-1/syllabus.pdf#page=2",
    });
    expect(
      decideWorkspaceWebPreviewNavigation(
        { url: "https://evil.example/payload.pdf", isTopFrame: true, navigationType: "other" },
        INITIAL_HTTPS_URI,
      ),
    ).toEqual({ action: "block" });
  });

  it("allows safe HTTP(S) and blank subframes", () => {
    expect(
      shouldStartWorkspaceWebPreviewLoad(
        { url: "https://cdn.example.com/embed.html", isTopFrame: false },
        INITIAL_HTTPS_URI,
      ),
    ).toBe(true);
    expect(
      shouldStartWorkspaceWebPreviewLoad(
        { url: "about:blank", isTopFrame: false },
        INITIAL_HTTPS_URI,
      ),
    ).toBe(true);
  });
});
