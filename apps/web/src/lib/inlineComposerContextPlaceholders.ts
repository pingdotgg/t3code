export function countInlineComposerContextPlaceholders(
  prompt: string,
  placeholder: string,
): number {
  let count = 0;
  for (const char of prompt) {
    if (char === placeholder) {
      count += 1;
    }
  }
  return count;
}

export function ensureInlineComposerContextPlaceholders(
  prompt: string,
  contextCount: number,
  placeholder: string,
): string {
  const missingCount = contextCount - countInlineComposerContextPlaceholders(prompt, placeholder);
  if (missingCount <= 0) {
    return prompt;
  }
  return `${placeholder.repeat(missingCount)}${prompt}`;
}

export function isInlineComposerContextPlaceholder(
  char: string | undefined,
  placeholders: ReadonlyArray<string>,
): boolean {
  return char !== undefined && placeholders.includes(char);
}

export function isInlineComposerContextBoundaryWhitespace(
  char: string | undefined,
  placeholders: ReadonlyArray<string>,
): boolean {
  return (
    char === undefined ||
    char === " " ||
    char === "\n" ||
    char === "\t" ||
    char === "\r" ||
    isInlineComposerContextPlaceholder(char, placeholders)
  );
}

export function insertInlineComposerContextPlaceholder(
  prompt: string,
  cursorInput: number,
  placeholder: string,
): { prompt: string; cursor: number; contextIndex: number } {
  const cursor = Math.max(0, Math.min(prompt.length, Math.floor(cursorInput)));
  const needsLeadingSpace = !isInlineComposerContextBoundaryWhitespace(prompt[cursor - 1], [
    placeholder,
  ]);
  const replacement = `${needsLeadingSpace ? " " : ""}${placeholder} `;
  const rangeEnd = prompt[cursor] === " " ? cursor + 1 : cursor;
  return {
    prompt: `${prompt.slice(0, cursor)}${replacement}${prompt.slice(rangeEnd)}`,
    cursor: cursor + replacement.length,
    contextIndex: countInlineComposerContextPlaceholders(prompt.slice(0, cursor), placeholder),
  };
}

export function stripInlineComposerContextPlaceholders(
  prompt: string,
  placeholders: ReadonlyArray<string>,
): string {
  let nextPrompt = prompt;
  for (const placeholder of placeholders) {
    nextPrompt = nextPrompt.replaceAll(placeholder, "");
  }
  return nextPrompt;
}

export function removeInlineComposerContextPlaceholder(
  prompt: string,
  placeholder: string,
  contextIndex: number,
): { prompt: string; cursor: number } {
  if (contextIndex < 0) {
    return { prompt, cursor: prompt.length };
  }

  let placeholderIndex = 0;
  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== placeholder) {
      continue;
    }
    if (placeholderIndex === contextIndex) {
      return {
        prompt: prompt.slice(0, index) + prompt.slice(index + 1),
        cursor: index,
      };
    }
    placeholderIndex += 1;
  }

  return { prompt, cursor: prompt.length };
}
