export const PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES = 32 * 1024;
/** Smaller pastes (a URL, a word) stay inline even when the prompt is already large. */
const PASTED_TEXT_CUMULATIVE_MIN_BYTES = 2 * 1024;

const textEncoder = new TextEncoder();

export type PastedTextDisposition = "attachment" | "inline";

/** Non-Latin layouts (Cyrillic, Greek) report the typed letter; fall back to the physical key. */
function isVKey(event: { readonly key: string; readonly code?: string }): boolean {
  const key = event.key.toLowerCase();
  return /^[a-z]$/.test(key) ? key === "v" : event.code === "KeyV";
}

export function isPasteAsTextShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
    readonly code?: string;
  },
  macPlatform: boolean,
): boolean {
  return (
    isVKey(event) &&
    event.shiftKey &&
    !event.altKey &&
    (macPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}

/**
 * The threshold is byte-based: character counts substantially understate the
 * context cost of some Unicode-heavy clipboard contents. It also applies to the
 * prompt the paste would produce, so several smaller pastes cannot stack up inline.
 */
export function pastedTextDisposition(input: {
  readonly text: string;
  readonly canAttach: boolean;
  readonly bypassAutoAttachment?: boolean;
  readonly wouldExceedInputLimit?: boolean;
  /** The prompt and its replaced selection; omit to judge the paste on its own. */
  readonly prompt?: {
    readonly value: string;
    readonly selection: { readonly start: number; readonly end: number };
  };
}): PastedTextDisposition {
  if (input.bypassAutoAttachment || !input.canAttach || input.text.length === 0) {
    return "inline";
  }
  if (input.wouldExceedInputLimit || input.text.length >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES) {
    return "attachment";
  }
  const textBytes = textEncoder.encode(input.text).byteLength;
  if (textBytes >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES) return "attachment";
  if (!input.prompt || textBytes < PASTED_TEXT_CUMULATIVE_MIN_BYTES) return "inline";
  const { value, selection } = input.prompt;
  const start = Math.max(0, Math.min(value.length, selection.start));
  const end = Math.max(start, Math.min(value.length, selection.end));
  const keptBytes = textEncoder.encode(value.slice(0, start) + value.slice(end)).byteLength;
  return keptBytes + textBytes >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES ? "attachment" : "inline";
}

export function nextPastedTextFileName(existingNames: ReadonlyArray<string>): string {
  const names = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!names.has("pasted-text.txt")) {
    return "pasted-text.txt";
  }
  for (let sequence = 2; ; sequence += 1) {
    const candidate = `pasted-text-${sequence}.txt`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
}

export function replaceTextSelection(input: {
  readonly value: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly text: string;
}): { readonly value: string; readonly cursor: number } {
  const start = Math.max(0, Math.min(input.value.length, input.selection.start));
  const end = Math.max(start, Math.min(input.value.length, input.selection.end));
  return {
    value: `${input.value.slice(0, start)}${input.text}${input.value.slice(end)}`,
    cursor: start + input.text.length,
  };
}

export function wouldTextPasteExceedLimit(input: {
  readonly valueLength: number;
  readonly selection: { readonly start: number; readonly end: number };
  readonly textLength: number;
  readonly maxLength: number;
}): boolean {
  const start = Math.max(0, Math.min(input.valueLength, input.selection.start));
  const end = Math.max(start, Math.min(input.valueLength, input.selection.end));
  return input.valueLength - (end - start) + input.textLength > input.maxLength;
}
