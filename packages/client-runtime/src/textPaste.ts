const textEncoder = new TextEncoder();

export type PastedTextDisposition = "attachment" | "inline";

export function isPasteAsTextShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  macPlatform: boolean,
): boolean {
  return (
    event.key.toLowerCase() === "v" &&
    event.shiftKey &&
    !event.altKey &&
    (macPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}

/**
 * `thresholdBytes` is the `pastedTextAttachmentThreshold` setting. It is compared
 * with both the length and the UTF-8 byte count: character counts substantially
 * understate the context cost of some Unicode-heavy clipboard contents.
 */
export function pastedTextDisposition(input: {
  readonly text: string;
  readonly canAttach: boolean;
  readonly thresholdBytes: number;
  readonly bypassAutoAttachment?: boolean;
  readonly wouldExceedInputLimit?: boolean;
}): PastedTextDisposition {
  if (input.bypassAutoAttachment || !input.canAttach || input.text.length === 0) {
    return "inline";
  }
  return input.wouldExceedInputLimit ||
    input.text.length >= input.thresholdBytes ||
    textEncoder.encode(input.text).byteLength >= input.thresholdBytes
    ? "attachment"
    : "inline";
}

/**
 * Settings label for a `pastedTextAttachmentThreshold` preset, such as
 * "5 KB (~5,000 chars)". Sizes come first because the threshold also counts
 * UTF-8 bytes, so non-Latin text and emoji fold with fewer characters.
 */
export function pastedTextThresholdLabel(thresholdBytes: number) {
  const kilobytes = Math.floor(thresholdBytes / 1000);
  return `${kilobytes} KB (~${(kilobytes * 1000).toLocaleString("en-US")} chars)`;
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
