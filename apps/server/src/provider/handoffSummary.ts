import type { ProviderKind } from "@t3tools/contracts";

const COMPACTION_TYPE_SNIPPETS = ["compact", "summary"];
const PREFERRED_TEXT_KEYS = [
  "compact_summary",
  "compactSummary",
  "summary",
  "text",
  "content",
  "message",
  "body",
] as const;
const IGNORED_OBJECT_KEYS = new Set([
  "id",
  "uuid",
  "type",
  "kind",
  "status",
  "createdAt",
  "updatedAt",
  "timestamp",
]);

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function normalizeType(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractStrings(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    const normalized = normalizeText(value);
    return normalized.length > 0 ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractStrings(entry, depth + 1));
  }
  if (typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const preferred = PREFERRED_TEXT_KEYS.flatMap((key) => extractStrings(record[key], depth + 1));
  if (preferred.length > 0) {
    return preferred;
  }

  return Object.entries(record).flatMap(([key, entry]) =>
    IGNORED_OBJECT_KEYS.has(key) ? [] : extractStrings(entry, depth + 1),
  );
}

function looksLikeCompactionItem(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const type = normalizeType(record.type ?? record.kind);
  if (COMPACTION_TYPE_SNIPPETS.some((snippet) => type.includes(snippet))) {
    return true;
  }
  return (
    typeof record.compact_summary === "string" ||
    typeof record.compactSummary === "string" ||
    typeof record.summary === "string"
  );
}

export function extractCompactionSummaryFromSnapshot(snapshot: {
  readonly turns: ReadonlyArray<{
    readonly items: ReadonlyArray<unknown>;
  }>;
}): string | null {
  const segments: string[] = [];
  for (const turn of snapshot.turns.toReversed()) {
    for (const item of turn.items.toReversed()) {
      if (!looksLikeCompactionItem(item)) {
        continue;
      }
      for (const segment of extractStrings(item)) {
        if (!segments.includes(segment)) {
          segments.push(segment);
        }
      }
      if (segments.length > 0) {
        const summary = segments.join("\n\n").trim();
        return summary.length > 0 ? summary : null;
      }
    }
  }
  return null;
}

function providerLabel(provider: ProviderKind): string {
  return provider === "claudeAgent" ? "Claude" : "Codex";
}

export function buildProviderSwitchHandoffInput(input: {
  readonly sourceProvider: ProviderKind;
  readonly targetProvider: ProviderKind;
  readonly compactSummary: string | null;
  readonly userMessage: string;
}): string {
  const sections = [
    "<provider_handoff>",
    `The conversation is continuing after a provider switch from ${providerLabel(input.sourceProvider)} to ${providerLabel(input.targetProvider)}.`,
    input.compactSummary
      ? `Native compaction summary from ${providerLabel(input.sourceProvider)}:\n${normalizeText(input.compactSummary)}`
      : `${providerLabel(input.sourceProvider)} compacted the thread before the switch, but did not expose a textual summary.`,
    "Carry forward the decisions and unfinished work in that summary when answering the user's next message.",
    "</provider_handoff>",
  ];

  const trimmedUserMessage = input.userMessage.trim();
  if (trimmedUserMessage.length > 0) {
    sections.push("", trimmedUserMessage);
  }

  return sections.join("\n");
}
