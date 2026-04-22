export interface PromptContextBlockEntry {
  header: string;
  body: string;
}

export interface PromptContextBlockInputEntry {
  header: string;
  bodyLines: ReadonlyArray<string>;
}

interface ExtractPromptContextBlockOptions {
  allowSingleLineEntries?: boolean;
}

export interface ExtractedPromptContextBlock {
  promptText: string;
  entries: PromptContextBlockEntry[];
  previewTitle: string | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trailingBlockPattern(tagName: string): RegExp {
  const escapedTagName = escapeRegExp(tagName);
  return new RegExp(`\\n*<${escapedTagName}>\\n([\\s\\S]*?)\\n<\\/${escapedTagName}>\\s*$`);
}

export function buildPromptContextBlock(
  tagName: string,
  entries: ReadonlyArray<PromptContextBlockInputEntry>,
): string {
  if (entries.length === 0) {
    return "";
  }

  const lines: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    lines.push(`- ${entry.header}:`);
    lines.push(...entry.bodyLines);
    if (index < entries.length - 1) {
      lines.push("");
    }
  }

  return [`<${tagName}>`, ...lines, `</${tagName}>`].join("\n");
}

export function appendPromptContextBlock(prompt: string, block: string): string {
  const trimmedPrompt = prompt.trim();
  if (block.length === 0) {
    return trimmedPrompt;
  }
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${block}` : block;
}

export function formatPromptContextPreviewTitle(
  entries: ReadonlyArray<PromptContextBlockEntry>,
): string | null {
  if (entries.length === 0) {
    return null;
  }

  return entries
    .map(({ header, body }) => (body.length > 0 ? `${header}\n${body}` : header))
    .join("\n\n");
}

export function extractTrailingPromptContextBlock(
  prompt: string,
  tagName: string,
  options: ExtractPromptContextBlockOptions = {},
): ExtractedPromptContextBlock {
  const match = trailingBlockPattern(tagName).exec(prompt);
  if (!match) {
    return {
      promptText: prompt,
      entries: [],
      previewTitle: null,
    };
  }

  const entries = parsePromptContextBlockEntries(match[1] ?? "", options);
  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/, ""),
    entries,
    previewTitle: formatPromptContextPreviewTitle(entries),
  };
}

function parsePromptContextBlockEntries(
  block: string,
  options: ExtractPromptContextBlockOptions,
): PromptContextBlockEntry[] {
  const entries: PromptContextBlockEntry[] = [];
  let current: { header: string; bodyLines: string[] } | null = null;

  const commitCurrent = () => {
    if (!current) {
      return;
    }

    entries.push({
      header: current.header,
      body: current.bodyLines.join("\n").trimEnd(),
    });
    current = null;
  };

  for (const rawLine of block.split("\n")) {
    if (options.allowSingleLineEntries) {
      const singleLineMatch = /^- (.+?): (.+)$/.exec(rawLine);
      if (singleLineMatch) {
        commitCurrent();
        entries.push({
          header: singleLineMatch[1]!,
          body: singleLineMatch[2]!,
        });
        continue;
      }
    }

    const headerMatch = /^- (.+):$/.exec(rawLine);
    if (headerMatch) {
      commitCurrent();
      current = {
        header: headerMatch[1]!,
        bodyLines: [],
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (rawLine.startsWith("  ")) {
      current.bodyLines.push(rawLine.slice(2));
      continue;
    }

    if (rawLine.length === 0) {
      current.bodyLines.push("");
    }
  }

  commitCurrent();
  return entries;
}
