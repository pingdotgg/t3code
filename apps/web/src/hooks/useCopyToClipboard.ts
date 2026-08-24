import * as React from "react";
import * as Schema from "effect/Schema";

import type { Translate } from "../i18n/messages";

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

export class ClipboardReadUnavailableError extends Schema.TaggedErrorClass<ClipboardReadUnavailableError>()(
  "ClipboardReadUnavailableError",
  {
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Clipboard API is unavailable while reading ${this.target}.`;
  }
}

export class ClipboardReadError extends Schema.TaggedErrorClass<ClipboardReadError>()(
  "ClipboardReadError",
  {
    target: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.target} from the clipboard.`;
  }
}

const ClipboardError = Schema.Union([
  ClipboardApiUnavailableError,
  ClipboardWriteError,
  ClipboardReadUnavailableError,
  ClipboardReadError,
]);
const isClipboardError = Schema.is(ClipboardError);

export function localizedClipboardErrorMessage(error: unknown, t: Translate): string {
  if (!isClipboardError(error)) {
    return error instanceof Error ? error.message : t("common.errorGeneric");
  }

  switch (error._tag) {
    case "ClipboardApiUnavailableError":
      return t("clipboard.error.apiUnavailable", { target: error.target });
    case "ClipboardWriteError":
      return t("clipboard.error.writeFailed", { target: error.target });
    case "ClipboardReadUnavailableError":
      return t("clipboard.error.readUnavailable", { target: error.target });
    case "ClipboardReadError":
      return t("clipboard.error.readFailed", { target: error.target });
  }
}

export async function writeTextToClipboard(value: string, target = "text") {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.clipboard?.writeText
  ) {
    throw new ClipboardApiUnavailableError({
      target,
    });
  }

  if (!value) return false;

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (cause) {
    throw new ClipboardWriteError({
      target,
      cause,
    });
  }
}

export async function readTextFromClipboard(target = "text"): Promise<string> {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.clipboard?.readText
  ) {
    throw new ClipboardReadUnavailableError({
      target,
    });
  }

  try {
    return await navigator.clipboard.readText();
  } catch (cause) {
    throw new ClipboardReadError({
      target,
      cause,
    });
  }
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
