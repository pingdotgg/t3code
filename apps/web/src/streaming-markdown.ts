// Streaming markdown is often syntactically incomplete mid-token. This helper
// temporarily appends closing delimiters for a small set of inline constructs so
// `react-markdown` can render partial assistant output without showing raw markup.
const FENCE_OPEN_PATTERN = /^[ \t]{0,3}((`{3,}|~{3,}))(.*)$/;
const FENCE_CLOSE_PATTERN = /^[ \t]{0,3}((`{3,}|~{3,}))[ \t]*$/;

function isWhitespace(char: string | undefined): boolean {
  return char == null || /\s/.test(char);
}

function isWordChar(char: string | undefined): boolean {
  return char != null && /[A-Za-z0-9]/.test(char);
}

interface InlineMarkdownScanState {
  inlineCodeDelimiter: number | null;
  openLinkLabelDepth: number;
  openLinkDestinationDepths: number[];
  openAutolink: boolean;
}

function scanInlineMarkdown(line: string, emphasisStack: string[], state: InlineMarkdownScanState) {
  let activeInlineCodeDelimiter = state.inlineCodeDelimiter;
  let openLinkLabelDepth = state.openLinkLabelDepth;
  const openLinkDestinationDepths = [...state.openLinkDestinationDepths];
  let openAutolink = state.openAutolink;

  for (let index = 0; index < line.length; ) {
    const char = line[index];
    if (char == null) {
      break;
    }

    if (char === "\\") {
      index += Math.min(2, line.length - index);
      continue;
    }

    if (char === "`") {
      let endIndex = index + 1;
      while (line[endIndex] === "`") {
        endIndex += 1;
      }

      const delimiterLength = endIndex - index;
      if (activeInlineCodeDelimiter === delimiterLength) {
        activeInlineCodeDelimiter = null;
      } else if (activeInlineCodeDelimiter == null) {
        activeInlineCodeDelimiter = delimiterLength;
      }

      index = endIndex;
      continue;
    }

    if (activeInlineCodeDelimiter == null) {
      if (openAutolink) {
        if (char === ">") {
          openAutolink = false;
        } else if (isWhitespace(char) || char === "<") {
          openAutolink = false;
        }
        index += 1;
        continue;
      }

      if (char === "<" && /^(https?:\/\/|mailto:)/i.test(line.slice(index + 1))) {
        openAutolink = true;
        index += 1;
        continue;
      }

      if (char === "[") {
        openLinkLabelDepth += 1;
        index += 1;
        continue;
      }

      if (char === "]") {
        if (openLinkLabelDepth > 0 && line[index + 1] === "(") {
          openLinkLabelDepth -= 1;
          openLinkDestinationDepths.push(0);
          index += 2;
          continue;
        }

        if (openLinkLabelDepth > 0) {
          openLinkLabelDepth -= 1;
        }

        index += 1;
        continue;
      }

      if (char === "(" && openLinkDestinationDepths.length > 0) {
        const lastIndex = openLinkDestinationDepths.length - 1;
        const currentDepth = openLinkDestinationDepths[lastIndex];
        if (currentDepth != null) {
          openLinkDestinationDepths[lastIndex] = currentDepth + 1;
        }
        index += 1;
        continue;
      }

      if (char === ")" && openLinkDestinationDepths.length > 0) {
        const lastIndex = openLinkDestinationDepths.length - 1;
        const currentDepth = openLinkDestinationDepths[lastIndex];
        if (currentDepth === 0) {
          openLinkDestinationDepths.pop();
        } else if (currentDepth != null) {
          openLinkDestinationDepths[lastIndex] = currentDepth - 1;
        }
        index += 1;
        continue;
      }

      if (char === "~" && line[index + 1] === "~") {
        let endIndex = index + 2;
        while (line[endIndex] === "~") {
          endIndex += 1;
        }

        const pairCount = Math.floor((endIndex - index) / 2);
        for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
          const topDelimiter = emphasisStack[emphasisStack.length - 1];
          if (topDelimiter === "~~") {
            emphasisStack.pop();
          } else {
            emphasisStack.push("~~");
          }
        }

        index += pairCount * 2;
        continue;
      }
    }

    if (activeInlineCodeDelimiter == null && (char === "*" || char === "_")) {
      let endIndex = index + 1;
      while (line[endIndex] === char) {
        endIndex += 1;
      }

      const delimiter = line.slice(index, endIndex);
      const previousChar = index > 0 ? line[index - 1] : undefined;
      const nextChar = line[endIndex];
      const canOpen = !isWhitespace(nextChar);
      const canClose = !isWhitespace(previousChar);
      const isIntrawordUnderscore =
        char === "_" && isWordChar(previousChar) && isWordChar(nextChar);

      if (!isIntrawordUnderscore) {
        const topDelimiter = emphasisStack[emphasisStack.length - 1];
        if (canClose && topDelimiter === delimiter) {
          emphasisStack.pop();
        } else if (canOpen) {
          emphasisStack.push(delimiter);
        }
      }

      index = endIndex;
      continue;
    }

    index += 1;
  }

  return {
    inlineCodeDelimiter: activeInlineCodeDelimiter,
    openLinkLabelDepth,
    openLinkDestinationDepths,
    openAutolink,
  };
}

export function finalizeStreamingMarkdown(text: string): string {
  if (text.length === 0) {
    return text;
  }

  const lines = text.split("\n");
  const emphasisStack: string[] = [];
  let inlineState: InlineMarkdownScanState = {
    inlineCodeDelimiter: null,
    openLinkLabelDepth: 0,
    openLinkDestinationDepths: [],
    openAutolink: false,
  };
  let openFence: { marker: "`" | "~"; length: number } | null = null;

  for (const line of lines) {
    if (openFence != null) {
      const closingMatch = line.match(FENCE_CLOSE_PATTERN);
      if (closingMatch) {
        const closingDelimiter = closingMatch[1] ?? "";
        if (
          closingDelimiter.startsWith(openFence.marker) &&
          closingDelimiter.length >= openFence.length
        ) {
          openFence = null;
        }
      }
      continue;
    }

    const openingMatch = line.match(FENCE_OPEN_PATTERN);
    if (openingMatch) {
      const delimiter = openingMatch[1] ?? "";
      const marker = delimiter[0];
      if (marker === "`" || marker === "~") {
        openFence = { marker, length: delimiter.length };
        inlineState = {
          inlineCodeDelimiter: null,
          openLinkLabelDepth: 0,
          openLinkDestinationDepths: [],
          openAutolink: false,
        };
      }
      continue;
    }

    inlineState = scanInlineMarkdown(line, emphasisStack, inlineState);
  }

  let suffix = "";
  if (openFence != null) {
    suffix += `${text.endsWith("\n") ? "" : "\n"}${openFence.marker.repeat(openFence.length)}`;
  }
  if (inlineState.inlineCodeDelimiter != null) {
    suffix += "`".repeat(inlineState.inlineCodeDelimiter);
  }
  if (inlineState.openLinkDestinationDepths.length > 0) {
    suffix += inlineState.openLinkDestinationDepths.map((depth) => ")".repeat(depth + 1)).join("");
  }
  if (inlineState.openAutolink) {
    suffix += ">";
  }
  if (emphasisStack.length > 0) {
    suffix += emphasisStack.toReversed().join("");
  }

  return `${text}${suffix}`;
}
