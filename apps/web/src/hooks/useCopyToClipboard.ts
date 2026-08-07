import * as React from "react";
import * as Schema from "effect/Schema";

export class ClipboardApiUnavailableError extends Schema.TaggedErrorClass<ClipboardApiUnavailableError>()(
  "ClipboardApiUnavailableError",
  {
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Clipboard API is unavailable while copying ${this.target}.`;
  }
}

export class ClipboardWriteError extends Schema.TaggedErrorClass<ClipboardWriteError>()(
  "ClipboardWriteError",
  {
    target: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to copy ${this.target} to the clipboard.`;
  }
}

/**
 * Legacy copy path via a hidden textarea and `document.execCommand("copy")`.
 *
 * The async Clipboard API only exists in secure contexts (HTTPS or
 * localhost) and can be denied in embedded webviews or when the document
 * lost focus, so this fallback keeps copy buttons working over plain HTTP
 * LAN/tailnet origins. It must run inside a user gesture (our click
 * handlers), and does not need `navigator.clipboard` at all.
 */
function legacyCopyTextToClipboard(value: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";

  const previouslyFocused = document.activeElement;
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, value.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    if (typeof HTMLElement !== "undefined" && previouslyFocused instanceof HTMLElement) {
      previouslyFocused.focus();
    }
  }
  return copied;
}

export async function writeTextToClipboard(value: string, target = "text") {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    throw new ClipboardApiUnavailableError({
      target,
    });
  }

  if (!value) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (cause) {
      // The async API is present but was denied (insecure origin, embedded
      // webview, permission policy). Try the legacy path before giving up.
      if (!legacyCopyTextToClipboard(value)) {
        throw new ClipboardWriteError({
          target,
          cause,
        });
      }
      return true;
    }
  }

  if (legacyCopyTextToClipboard(value)) {
    return true;
  }

  throw new ClipboardApiUnavailableError({
    target,
  });
}

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  target = "text",
  onCopy,
  onError,
}: {
  timeout?: number;
  target?: string;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<NodeJS.Timeout | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const targetRef = React.useRef(target);
  const timeoutRef = React.useRef(timeout);

  onCopyRef.current = onCopy;
  onErrorRef.current = onError;
  targetRef.current = target;
  timeoutRef.current = timeout;

  const copyToClipboard = React.useCallback((value: string, ctx: TContext): void => {
    void writeTextToClipboard(value, targetRef.current).then(
      (didCopy) => {
        if (!didCopy) return;
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);

        onCopyRef.current?.(ctx);

        if (timeoutRef.current !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeoutRef.current);
        }
      },
      (error) => {
        console.error(error);
        onErrorRef.current?.(error, ctx);
      },
    );
  }, []);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}
