import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BrowserDocumentFrame, isBlockedFrameViolation } from "./BrowserDocumentFrame";

const src = "https://environment.test/api/assets/thread/page.html?signature=abc";

describe("isBlockedFrameViolation", () => {
  it("matches a refused frame reported with its full URL", () => {
    expect(isBlockedFrameViolation(src, { directive: "frame-src", blockedURI: src })).toBe(true);
  });

  it("matches a refused frame reported as a bare origin", () => {
    expect(
      isBlockedFrameViolation(src, {
        directive: "frame-src",
        blockedURI: "https://environment.test",
      }),
    ).toBe(true);
  });

  it("matches the legacy directive name browsers still report", () => {
    expect(isBlockedFrameViolation(src, { directive: "child-src 'self'", blockedURI: src })).toBe(
      true,
    );
  });

  it("ignores a frame served by another environment", () => {
    expect(
      isBlockedFrameViolation(src, {
        directive: "frame-src",
        blockedURI: "https://other.test/page.html",
      }),
    ).toBe(false);
  });

  it("ignores violations of other directives and unparseable reports", () => {
    expect(isBlockedFrameViolation(src, { directive: "img-src", blockedURI: src })).toBe(false);
    expect(isBlockedFrameViolation(src, { directive: "frame-src", blockedURI: "inline" })).toBe(
      false,
    );
  });
});

vi.mock("./fileSurfaceChrome", () => ({
  FileSurfaceFailure: ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
    <div role="alert" onClick={onRetry}>
      {message}
    </div>
  ),
}));

describe("document preview failures", () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const open = async (source: string) => {
    await act(async () => {
      renderer = create(<BrowserDocumentFrame src={source} title="page.html" pdf={false} />);
    });
  };

  const alert = () => renderer.root.findAllByProps({ role: "alert" })[0];

  it("reports a document the environment no longer serves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );
    await open(src);
    expect(alert()?.props.children).toBe("This document is no longer available.");
  });

  it("reports an environment that cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await open(src);
    expect(alert()?.props.children).toBe("Could not reach the environment serving this document.");
  });

  it("retrying clears the failure and asks the environment again", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValue(new Response("<p>ok</p>"));
    vi.stubGlobal("fetch", fetchMock);
    await open(src);
    await act(async () => alert()?.props.onClick());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(alert()).toBeUndefined();
    expect(renderer.root.findAllByType("iframe")).toHaveLength(1);
  });

  it("renders a local blob document without asking the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await open("blob:t3code://app/9f1c");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(alert()).toBeUndefined();
    expect(renderer.root.findAllByType("iframe")).toHaveLength(1);
  });
});
