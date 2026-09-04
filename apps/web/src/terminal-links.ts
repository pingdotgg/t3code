import {
  type TerminalLinkMatch,
  extractTerminalLinks,
  isAbsolutePath,
  isTerminalUrl,
  resolvePathLinkTarget,
  splitPathAndPosition,
  type TerminalLinkKind,
} from "@t3tools/shared/terminalLinks";

import { isMacPlatform } from "./lib/utils";

export {
  extractTerminalLinks,
  isAbsolutePath,
  isTerminalUrl,
  resolvePathLinkTarget,
  splitPathAndPosition,
  type TerminalLinkKind,
  type TerminalLinkMatch,
};

export interface TerminalLinkBufferPosition {
  x: number;
  y: number;
}

export interface TerminalLinkBufferRange {
  start: TerminalLinkBufferPosition;
  end: TerminalLinkBufferPosition;
}

export interface TerminalBufferLineLike {
  readonly isWrapped?: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface WrappedTerminalLinkLineSegment {
  bufferLineNumber: number;
  text: string;
  startIndex: number;
  endIndex: number;
}

export interface WrappedTerminalLinkLine {
  text: string;
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>;
}

export function collectWrappedTerminalLinkLine(
  bufferLineNumber: number,
  getLine: (bufferLineIndex: number) => TerminalBufferLineLike | null | undefined,
): WrappedTerminalLinkLine | null {
  const anchorLine = getLine(bufferLineNumber - 1);
  if (!anchorLine) return null;

  let startBufferLineNumber = bufferLineNumber;
  let startLine = anchorLine;

  while (startBufferLineNumber > 1 && startLine.isWrapped) {
    const previousLine = getLine(startBufferLineNumber - 2);
    if (!previousLine) return null;
    startBufferLineNumber -= 1;
    startLine = previousLine;
  }

  const segments: WrappedTerminalLinkLineSegment[] = [];
  let nextStartIndex = 0;
  let currentBufferLineNumber = startBufferLineNumber;

  while (true) {
    const currentLine = getLine(currentBufferLineNumber - 1);
    if (!currentLine) break;

    const nextLine = getLine(currentBufferLineNumber);
    const hasWrappedContinuation = nextLine?.isWrapped === true;
    const text = currentLine.translateToString(!hasWrappedContinuation);

    segments.push({
      bufferLineNumber: currentBufferLineNumber,
      text,
      startIndex: nextStartIndex,
      endIndex: nextStartIndex + text.length,
    });
    nextStartIndex += text.length;

    if (!hasWrappedContinuation) break;
    currentBufferLineNumber += 1;
  }

  return {
    text: segments.map((segment) => segment.text).join(""),
    segments,
  };
}

function resolveCharacterPosition(
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>,
  characterIndex: number,
): TerminalLinkBufferPosition {
  for (const segment of segments) {
    if (characterIndex < segment.endIndex) {
      return {
        x: characterIndex - segment.startIndex + 1,
        y: segment.bufferLineNumber,
      };
    }
  }

  const lastSegment = segments[segments.length - 1];
  return {
    x: Math.max(lastSegment?.text.length ?? 0, 1),
    y: lastSegment?.bufferLineNumber ?? 1,
  };
}

export function resolveWrappedTerminalLinkRange(
  wrappedLine: WrappedTerminalLinkLine,
  match: Pick<TerminalLinkMatch, "start" | "end">,
): TerminalLinkBufferRange {
  return {
    start: resolveCharacterPosition(wrappedLine.segments, match.start),
    end: resolveCharacterPosition(wrappedLine.segments, match.end - 1),
  };
}

export function wrappedTerminalLinkRangeIntersectsBufferLine(
  range: TerminalLinkBufferRange,
  bufferLineNumber: number,
): boolean {
  return range.start.y <= bufferLineNumber && bufferLineNumber <= range.end.y;
}

export function isTerminalLinkActivation(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (platform.length === 0) return false;
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
