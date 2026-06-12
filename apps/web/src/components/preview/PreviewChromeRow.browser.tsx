import "../../index.css";

import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { PreviewChromeRow } from "./PreviewChromeRow";

const defaultProps = {
  url: "https://example.com/",
  loading: false,
  loadProgress: 0,
  canGoBack: false,
  canGoForward: false,
  refreshDisabled: false,
  onBack: vi.fn(),
  onForward: vi.fn(),
  onRefresh: vi.fn(),
  onSubmit: vi.fn(),
};

describe("PreviewChromeRow", () => {
  it("only focuses the URL input after an explicit focus request", async () => {
    const previouslyFocused = document.createElement("button");
    document.body.append(previouslyFocused);
    previouslyFocused.focus();

    const screen = await render(<PreviewChromeRow {...defaultProps} focusUrlNonce={undefined} />);
    const input = page.getByRole("textbox").element() as HTMLInputElement;

    expect(document.activeElement).toBe(previouslyFocused);

    await screen.rerender(<PreviewChromeRow {...defaultProps} focusUrlNonce={1} />);

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);

    previouslyFocused.remove();
  });
});
