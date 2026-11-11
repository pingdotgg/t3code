import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useOtpPasteNormalizer } from "./otpPaste";

// Mirrors input-otp's controlled input: a paste with any non-digit is rejected whole.
function CodeField() {
  useOtpPasteNormalizer();
  const [value, setValue] = useState("");
  return (
    <input
      data-input-otp="true"
      maxLength={6}
      value={value}
      onChange={(event) => {
        const next = event.currentTarget.value.slice(0, 6);
        if (next.length > 0 && !/^\d+$/.test(next)) return;
        setValue(next);
      }}
    />
  );
}

function paste(input: HTMLInputElement, text: string) {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  return event;
}

describe("useOtpPasteNormalizer", () => {
  it("fills Clerk's code field from a code copied with surrounding spaces", async () => {
    await using screen = await render(<CodeField />);
    const input = screen.container.querySelector<HTMLInputElement>("input[data-input-otp]")!;
    input.focus();

    let event!: ClipboardEvent;
    await act(async () => {
      event = paste(input, " 123 456 ");
    });

    expect(event.defaultPrevented).toBe(true);
    // Rerendering makes React restore the DOM from state, so this checks onChange took the code.
    await screen.rerender(<CodeField />);
    await expect.element(input).toHaveValue("123456");
  });

  it("replaces existing digits when a full code is pasted", async () => {
    await using screen = await render(<CodeField />);
    const input = screen.container.querySelector<HTMLInputElement>("input[data-input-otp]")!;
    input.focus();
    await act(async () => {
      paste(input, "1 2");
    });
    await act(async () => {
      paste(input, " 345678");
    });

    await screen.rerender(<CodeField />);
    await expect.element(input).toHaveValue("345678");
  });

  it("keeps the caret after a fragment pasted into an earlier slot", async () => {
    await using screen = await render(<CodeField />);
    const input = screen.container.querySelector<HTMLInputElement>("input[data-input-otp]")!;
    input.focus();
    await act(async () => {
      paste(input, "1 2345");
    });
    input.setSelectionRange(1, 2);
    await act(async () => {
      paste(input, "98 ");
    });

    await expect.element(input).toHaveValue("198345");
    expect(input.selectionStart).toBe(3);
    expect(input.selectionEnd).toBe(3);
    input.setSelectionRange(1, 2);
    await act(async () => {
      paste(input, "76 ");
    });
    await screen.rerender(<CodeField />);
    await expect.element(input).toHaveValue("178345");
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
  });

  it("leaves clean codes to the field's own paste handling", async () => {
    await using screen = await render(<CodeField />);
    const input = screen.container.querySelector<HTMLInputElement>("input[data-input-otp]")!;
    expect(paste(input, "123456").defaultPrevented).toBe(false);
  });
});
