import type { ServerLocalAgentCommand, ServerLocalAgentSkill } from "@forma/contracts";

type LocalAgentFrontmatter = Record<string, string>;

export interface ParsedLocalAgentSkillDocument {
  readonly skill: ServerLocalAgentSkill;
  readonly contents: string;
}

export interface ParsedLocalAgentCommandDocument {
  readonly command: ServerLocalAgentCommand;
  readonly promptTemplate: string;
}

function normalizeMetadataKey(key: string): string {
  return key.trim().toLowerCase().replaceAll("_", "-");
}

function normalizeNewlines(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function parseFrontmatterEntry(line: string): [string, string] | null {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  const key = normalizeMetadataKey(line.slice(0, separatorIndex));
  const value = line.slice(separatorIndex + 1).trim();
  if (!key || !value) {
    return null;
  }

  return [key, value];
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function sanitizeSummaryLine(value: string): string {
  return value
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^>\s*/, "");
}

function fallbackDescriptionFromMarkdown(contents: string): string | undefined {
  for (const rawLine of normalizeNewlines(contents).split("\n")) {
    const line = sanitizeSummaryLine(rawLine);
    if (!line) {
      continue;
    }
    return line;
  }
  return undefined;
}

function readMetadataValue(
  metadata: LocalAgentFrontmatter,
  ...keys: ReadonlyArray<string>
): string | undefined {
  for (const key of keys) {
    const value = metadata[normalizeMetadataKey(key)];
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function parseLocalAgentMarkdownDocument(source: string): {
  readonly metadata: LocalAgentFrontmatter;
  readonly body: string;
} {
  const normalizedSource = normalizeNewlines(source);
  if (!normalizedSource.startsWith("---\n")) {
    return {
      metadata: {},
      body: normalizedSource.trim(),
    };
  }

  const closingDelimiterIndex = normalizedSource.indexOf("\n---\n", 4);
  if (closingDelimiterIndex === -1) {
    return {
      metadata: {},
      body: normalizedSource.trim(),
    };
  }

  const rawFrontmatter = normalizedSource.slice(4, closingDelimiterIndex);
  const body = normalizedSource.slice(closingDelimiterIndex + "\n---\n".length).trim();
  const metadata: LocalAgentFrontmatter = {};

  for (const line of rawFrontmatter.split("\n")) {
    const entry = parseFrontmatterEntry(line);
    if (!entry) {
      continue;
    }
    const [key, value] = entry;
    metadata[key] = value;
  }

  return { metadata, body };
}

export function parseLocalAgentSkillDocument(input: {
  readonly contents: string;
  readonly defaultName: string;
  readonly path: string;
}): ParsedLocalAgentSkillDocument {
  const { metadata, body } = parseLocalAgentMarkdownDocument(input.contents);
  const resolvedDescription =
    readMetadataValue(metadata, "description") ?? fallbackDescriptionFromMarkdown(body);
  const skill: ServerLocalAgentSkill = {
    name: readMetadataValue(metadata, "name") ?? input.defaultName,
    path: input.path,
    scope: "project",
    enabled: parseBoolean(readMetadataValue(metadata, "enabled")) ?? true,
    source: "local-agents",
    ...(readMetadataValue(metadata, "display-name", "displayName")
      ? {
          displayName: readMetadataValue(metadata, "display-name", "displayName"),
        }
      : {}),
    ...(resolvedDescription ? { description: resolvedDescription } : {}),
    ...(readMetadataValue(metadata, "short-description", "shortDescription")
      ? {
          shortDescription: readMetadataValue(metadata, "short-description", "shortDescription"),
        }
      : resolvedDescription
        ? { shortDescription: resolvedDescription }
        : {}),
  };

  return {
    skill,
    contents: body,
  };
}

export function parseLocalAgentCommandMarkdownDocument(input: {
  readonly contents: string;
  readonly defaultName: string;
  readonly path: string;
}): ParsedLocalAgentCommandDocument {
  const { metadata, body } = parseLocalAgentMarkdownDocument(input.contents);
  const resolvedDescription =
    readMetadataValue(metadata, "description") ?? fallbackDescriptionFromMarkdown(body);

  return {
    command: {
      name: readMetadataValue(metadata, "name") ?? input.defaultName,
      path: input.path,
      scope: "project",
      source: "local-agents",
      ...(resolvedDescription ? { description: resolvedDescription } : {}),
      ...(readMetadataValue(metadata, "argument-hint", "argumentHint")
        ? {
            inputHint: readMetadataValue(metadata, "argument-hint", "argumentHint"),
          }
        : {}),
    },
    promptTemplate: body,
  };
}

export function parseLocalAgentCommandJsonDocument(input: {
  readonly contents: string;
  readonly defaultName: string;
  readonly path: string;
}): ParsedLocalAgentCommandDocument {
  const parsed = JSON.parse(input.contents) as {
    name?: unknown;
    description?: unknown;
    inputHint?: unknown;
    promptTemplate?: unknown;
  };

  return {
    command: {
      name:
        typeof parsed.name === "string" && parsed.name.trim().length > 0
          ? parsed.name.trim()
          : input.defaultName,
      path: input.path,
      scope: "project",
      source: "local-agents",
      ...(typeof parsed.description === "string" && parsed.description.trim().length > 0
        ? { description: parsed.description.trim() }
        : {}),
      ...(typeof parsed.inputHint === "string" && parsed.inputHint.trim().length > 0
        ? { inputHint: parsed.inputHint.trim() }
        : {}),
    },
    promptTemplate:
      typeof parsed.promptTemplate === "string"
        ? normalizeNewlines(parsed.promptTemplate).trim()
        : "",
  };
}

export function renderLocalAgentCommandPromptTemplate(
  template: string,
  rawArguments: string,
): string {
  const normalizedArguments = rawArguments.trim();
  const positionalArguments =
    normalizedArguments.length === 0 ? [] : normalizedArguments.split(/\s+/);

  return template
    .replaceAll("$ARGUMENTS", normalizedArguments)
    .replace(/\$([1-9]\d*)/g, (_match, indexValue: string) => {
      const index = Number.parseInt(indexValue, 10) - 1;
      return positionalArguments[index] ?? "";
    })
    .trim();
}
