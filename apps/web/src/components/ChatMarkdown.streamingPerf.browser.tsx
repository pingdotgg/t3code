import "../index.css";

import type { ReactNode } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const markdownRenderCount = vi.hoisted(() => ({ value: 0 }));

vi.mock("react-markdown", async () => {
  const React = await import("react");
  return {
    defaultUrlTransform: (value: string) => value,
    default: React.memo(function CountedReactMarkdown({ children }: { children?: ReactNode }) {
      markdownRenderCount.value += 1;
      return React.createElement("div", { "data-testid": "markdown-body" }, children);
    }),
  };
});

import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown streaming performance", () => {
  afterEach(() => {
    markdownRenderCount.value = 0;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("coalesces streaming Markdown parses to one per animation frame and flushes completion", async () => {
    const pendingFrames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const frameId = ++nextFrameId;
      pendingFrames.set(frameId, callback);
      return frameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
      pendingFrames.delete(frameId);
    });

    let text = `Streaming response ${"word ".repeat(300)}`;
    const screen = await render(<ChatMarkdown text={text} cwd="/repo/project" isStreaming />);

    try {
      expect(markdownRenderCount.value).toBe(1);
      for (let chunk = 0; chunk < 20; chunk += 1) {
        text += `chunk-${chunk} `;
        await screen.rerender(<ChatMarkdown text={text} cwd="/repo/project" isStreaming />);
      }

      expect(markdownRenderCount.value).toBe(1);
      expect(pendingFrames.size).toBe(1);
      const [frameId, renderLatestText] = [...pendingFrames.entries()][0]!;
      pendingFrames.delete(frameId);
      renderLatestText(performance.now());
      await vi.waitFor(() => expect(markdownRenderCount.value).toBe(2));
      await expect.element(page.getByTestId("markdown-body")).toHaveTextContent(/chunk-19/);

      text += "final response";
      await screen.rerender(<ChatMarkdown text={text} cwd="/repo/project" isStreaming={false} />);
      await expect.element(page.getByTestId("markdown-body")).toHaveTextContent(/final response/);
      expect(markdownRenderCount.value).toBe(3);
      expect(pendingFrames.size).toBe(0);
    } finally {
      await screen.unmount();
    }
  });
});
