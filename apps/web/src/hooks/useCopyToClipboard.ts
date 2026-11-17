import * as React from "react";
import * as Schema from "effect/Schema";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import { msg } from "gt-react";

import { m } from "../i18n/messages";
import { useStableCallback } from "./useStableCallback";

/**
 * A bare string is an English noun, kept for logs and interpolated into the fallback sentences.
 * Pass the object with `msg()` sentences, resolved when the error is shown, so users read whole ones.
 */
export type ClipboardTarget =
  | string
  | {
      readonly target: string;
      /** Shown when the clipboard API is missing. */
      readonly unavailableMessage: string;
      /** Shown when the browser rejects the copy or read. */
      readonly failureMessage: string;
    };

const DEFAULT_CLIPBOARD_TARGET = "text";

function clipboardTargetFields(target: ClipboardTarget, failure: "unavailable" | "failure") {
  if (typeof target === "string") return { target };
  return {
    target: target.target,
    displayMessage: failure === "unavailable" ? target.unavailableMessage : target.failureMessage,
  };
}

export class ClipboardApiUnavailableError extends Schema.TaggedError<ClipboardApiUnavailableError>()(
  "ClipboardApiUnavailableError",
  {
    target: Schema.String,
    displayMessage: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    if (this.displayMessage !== undefined) return m(this.displayMessage);
    return this.target === DEFAULT_CLIPBOARD_TARGET
      ? m(msg("Clipboard API is unavailable while copying text."))
      : m(msg("Clipboard API is unavailable while copying {target}.", { target: this.target }));
  }
}

export class ClipboardWriteError extends Schema.TaggedError<ClipboardWriteError>()(
  "ClipboardWriteError",
  {
    target: Schema.String,
    displayMessage: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    if (this.displayMessage !== undefined) return m(this.displayMessage);
    return this.target === DEFAULT_CLIPBOARD_TARGET
      ? m(msg("Failed to copy text to the clipboard."))
      : m(msg("Failed to copy {target} to the clipboard.", { target: this.target }));
  }
}

export class ClipboardReadUnavailableError extends Schema.TaggedError<ClipboardReadUnavailableError>()(
  "ClipboardReadUnavailableError",
  {
    target: Schema.String,
    displayMessage: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    if (this.displayMessage !== undefined) return m(this.displayMessage);
    return this.target === DEFAULT_CLIPBOARD_TARGET
      ? m(msg("Clipboard API is unavailable while reading text."))
      : m(msg("Clipboard API is unavailable while reading {target}.", { target: this.target }));
  }
}

export class ClipboardReadError extends Schema.TaggedError<ClipboardReadError>()(
  "ClipboardReadError",
  {
    target: Schema.String,
    displayMessage: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    if (this.displayMessage !== undefined) return m(this.displayMessage);
    return this.target === DEFAULT_CLIPBOARD_TARGET
      ? m(msg("Failed to read text from the clipboard."))
      : m(msg("Failed to read {target} from the clipboard.", { target: this.target }));
  }
}

function writeTextWithExecCommand(
  value: string,
  extraFlavors?: Readonly<Record<string, string>>,
): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.fontSize = "16px";

  const previouslyFocused = document.activeElement;
  const copy = (event: ClipboardEvent) => {
    if (!extraFlavors || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", value);
    for (const [type, data] of Object.entries(extraFlavors))
      event.clipboardData.setData(type, data);
    event.preventDefault();
  };
  document.body.appendChild(textarea);
  textarea.addEventListener("copy", copy);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.removeEventListener("copy", copy);
    textarea.remove();
    const restoreFocus = (previouslyFocused as { focus?: unknown } | null)?.focus;
    if (typeof restoreFocus === "function") {
      restoreFocus.call(previouslyFocused);
    }
  }
}

export async function writeTextToClipboard(
  value: string,
  target: ClipboardTarget = DEFAULT_CLIPBOARD_TARGET,
  extraFlavors?: Readonly<Record<string, string>>,
) {
  if (typeof window === "undefined") {
    throw new ClipboardApiUnavailableError(clipboardTargetFields(target, "unavailable"));
  }

  if (!value) return false;
  if (extraFlavors) {
    extraFlavors = Object.fromEntries(
      Object.entries(extraFlavors).filter(([type]) => type !== "text/plain"),
    );
  }
  const contextFragment = extraFlavors?.[COMPOSER_CONTEXT_CLIPBOARD_MIME];
  if (contextFragment)
    extraFlavors = {
      ...extraFlavors,
      "text/html": encodeComposerContextClipboardHtml(
        value,
        contextFragment,
        extraFlavors?.["text/html"],
      ),
    };

  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    if (writeTextWithExecCommand(value, extraFlavors)) return true;
    throw new ClipboardApiUnavailableError(clipboardTargetFields(target, "unavailable"));
  }

  try {
    if (extraFlavors && typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([value], { type: "text/plain" }),
            ...Object.fromEntries(
              Object.entries(extraFlavors).map(([type, data]) => [
                type,
                new Blob([data], { type }),
              ]),
            ),
          }),
        ]);
        return true;
      } catch {
        // Safari/native bridges may accept HTML but reject Chromium's custom web flavor.
        const html = extraFlavors["text/html"];
        if (html) {
          try {
            await navigator.clipboard.write([
              new ClipboardItem({
                "text/plain": new Blob([value], { type: "text/plain" }),
                "text/html": new Blob([html], { type: "text/html" }),
              }),
            ]);
            return true;
          } catch {}
        }
      }
    }
    await navigator.clipboard.writeText(value);
    return true;
  } catch (cause) {
    throw new ClipboardWriteError({ ...clipboardTargetFields(target, "failure"), cause });
  }
}

export async function readTextFromClipboard(
  target: ClipboardTarget = DEFAULT_CLIPBOARD_TARGET,
): Promise<string> {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.clipboard?.readText
  ) {
    throw new ClipboardReadUnavailableError(clipboardTargetFields(target, "unavailable"));
  }

  try {
    return await navigator.clipboard.readText();
  } catch (cause) {
    throw new ClipboardReadError({ ...clipboardTargetFields(target, "failure"), cause });
  }
}

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  target = DEFAULT_CLIPBOARD_TARGET,
  onCopy,
  onError,
  extraFlavors,
}: {
  timeout?: number;
  target?: ClipboardTarget;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
  extraFlavors?: Readonly<Record<string, string>>;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<NodeJS.Timeout | null>(null);
  const copyToClipboard = useStableCallback((value: string, ctx: TContext): void => {
    void writeTextToClipboard(value, target, extraFlavors).then(
      (didCopy) => {
        if (!didCopy) return;
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);

        onCopy?.(ctx);

        if (timeout !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeout);
        }
      },
      (error) => {
        console.error(error);
        onError?.(error, ctx);
      },
    );
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the copied-state reset timer on unmount
  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}
