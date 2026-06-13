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

  it("shows a friendly asset label until the URL input receives focus", async () => {
    const fullUrl = "http://127.0.0.1:3773/api/assets/token/report.pdf";
    await render(
      <PreviewChromeRow
        {...defaultProps}
        url={fullUrl}
        displayUrl="Local environment · report.pdf"
      />,
    );
    const input = page.getByRole("textbox");

    await expect.element(input).toHaveValue("Local environment · report.pdf");

    await input.click();

    await expect.element(input).toHaveValue(fullUrl);

    input.element().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await expect.element(input).toHaveValue("Local environment · report.pdf");
  });

  it("shows only the host for regular URLs until the input receives focus", async () => {
    const fullUrl = "https://t3.chat/chat/18378834-f776-4507-ada7-6f79";
    await render(<PreviewChromeRow {...defaultProps} url={fullUrl} displayUrl="t3.chat" />);
    const input = page.getByRole("textbox");

    await expect.element(input).toHaveValue("t3.chat");

    await input.click();

    await expect.element(input).toHaveValue(fullUrl);
  });
});
