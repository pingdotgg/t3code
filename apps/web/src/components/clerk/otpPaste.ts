import { useEffect } from "react";

/** input-otp (behind Clerk's verification code boxes) marks its hidden input with this attribute. */
const OTP_INPUT_SELECTOR = "input[data-input-otp]";

// Spaces, NBSP, zero-width characters, and the dash/dot separators email clients put in or around codes.
const OTP_SEPARATOR_PATTERN = /[\s ​-‍⁠﻿\-‐-―.]/g;

/**
 * Clerk's code field accepts only digits and rejects a whole paste that contains anything else, so a
 * code copied from an email with a stray space or separator (" 123456", "123 456") is silently dropped.
 * Returns the digits when the pasted text is a separated code, or null when it needs no help or is not a code.
 */
export function normalizePastedOtpCode(text: string, maxLength: number): string | null {
  const digits = text.replace(OTP_SEPARATOR_PATTERN, "");
  if (digits === text || digits.length === 0 || digits.length > maxLength) return null;
  return /^\d+$/.test(digits) ? digits : null;
}

function handleOtpPaste(event: ClipboardEvent) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.matches(OTP_INPUT_SELECTOR)) return;
  if (event.defaultPrevented || !event.clipboardData) return;
  const maxLength = input.maxLength > 0 ? input.maxLength : 6;
  const code = normalizePastedOtpCode(event.clipboardData.getData("text/plain"), maxLength);
  if (code === null) return;

  event.preventDefault();
  // A full-length code replaces whatever is there; a shorter fragment goes in at the selection.
  const start = code.length === maxLength ? 0 : (input.selectionStart ?? input.value.length);
  const end = code.length === maxLength ? input.value.length : (input.selectionEnd ?? start);
  const available = maxLength - (input.value.length - (end - start));
  const inserted = code.slice(0, Math.max(0, available));
  const nextValue = input.value.slice(0, start) + inserted + input.value.slice(end);
  // React tracks the last value it saw; the prototype setter plus a bubbling input event reaches its onChange.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, nextValue);
  // Setting the value moves the caret to the end; put it back after the pasted digits.
  const caret = start + inserted.length;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Lets pasted email verification codes with spaces or dashes fill Clerk's code field. */
export function useOtpPasteNormalizer() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches a window paste capture listener that cleans codes pasted into Clerk's verification field
  useEffect(() => {
    window.addEventListener("paste", handleOtpPaste, true);
    return () => window.removeEventListener("paste", handleOtpPaste, true);
  }, []);
}
