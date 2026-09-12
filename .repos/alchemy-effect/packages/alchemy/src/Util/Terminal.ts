/** Terminal-emulator features shared by CliKit components. */
import {
  detectColorLevel,
  detectUnicodeSupport,
} from "@alchemy.run/sigil/capabilities";
import {
  setClipboard,
  setTerminalProgress,
  tmuxPassthrough,
  type TerminalProgressState,
} from "@alchemy.run/sigil/ansi";
import stringWidth from "string-width";

export const ANSI_RESET = "\u001B[0m";
export const ANSI_BOLD = "\u001B[1m";
export const ANSI_DIM = "\u001B[2m";

/** Truecolor foreground escape for raw, non-layout output. */
export const ansiFg = (hex: string) => {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `\u001B[38;2;${red};${green};${blue}m`;
};

/**
 * The canonical color-support decision, shared by raw terminal strings and
 * CliKit capability detection so the two can never disagree.
 */
export const colorsEnabled = (
  stream: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout,
): boolean => detectColorLevel(stream) > 0;

/** The canonical Unicode-support decision for raw terminal strings. */
export const unicodeEnabled = detectUnicodeSupport;

/** Environment override for child processes whose piped output returns here. */
export const pipedColorEnv = (): Record<string, string> =>
  colorsEnabled() ? { FORCE_COLOR: process.env.FORCE_COLOR ?? "1" } : {};

export const paint = (code: string, value: string): string =>
  colorsEnabled() ? `${code}${value}${ANSI_RESET}` : value;

export const copyToClipboard = (
  text: string,
  stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): void => {
  let sequence = setClipboard(text);
  if (process.env.TMUX !== undefined) {
    sequence = tmuxPassthrough(sequence);
  }
  stdout.write(sequence);
};

export const setNativeProgress = (
  state: TerminalProgressState,
  value?: number,
  stdout: Pick<NodeJS.WriteStream, "write" | "isTTY"> = process.stdout,
): void => {
  if (stdout.isTTY !== true) return;
  let sequence = setTerminalProgress(state, value);
  if (process.env.TMUX !== undefined) sequence = tmuxPassthrough(sequence);
  stdout.write(sequence);
};

const truncateSegmenter = new Intl.Segmenter();

/** Display-width-aware truncation (wide CJK/emoji count by rendered cells). */
export const truncate = (value: string, width: number): string => {
  const max = Math.max(4, width);
  if (stringWidth(value) <= max) return value;
  let total = 0;
  let kept = "";
  for (const { segment } of truncateSegmenter.segment(value)) {
    const segmentWidth = stringWidth(segment);
    if (total + segmentWidth > max - 1) break;
    total += segmentWidth;
    kept += segment;
  }
  return `${kept}…`;
};
