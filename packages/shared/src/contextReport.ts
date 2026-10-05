import { parseClaudeContextReport } from "./claudeContextReport.ts";

export { parseClaudeContextReport as parseContextReport } from "./claudeContextReport.ts";

export interface ContextCategory {
  readonly name: string;
  readonly tokens: string;
  readonly percent: number;
}

export interface ContextSection {
  readonly title: string;
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  readonly totalTokens: number | null;
}

export interface ContextReport {
  readonly model: string | null;
  readonly usedTokens: string;
  readonly maxTokens: string;
  readonly usedPercent: number;
  readonly overLimit: string | null;
  readonly categories: ReadonlyArray<ContextCategory>;
  readonly sections: ReadonlyArray<ContextSection>;
}

const FREE_SPACE_CATEGORIES = new Set(["Free space", "Autocompact buffer"]);

const REPORTED_USAGE_COUNTERS = [
  ["inputTokens", "Input"],
  ["cachedInputTokens", "Cached input"],
  ["outputTokens", "Output"],
  ["reasoningOutputTokens", "Reasoning"],
] as const;

export function contextReportFromUsage(
  usage:
    | {
        readonly usedTokens: number;
        readonly maxTokens?: number | null | undefined;
        readonly inputTokens?: number | undefined;
        readonly cachedInputTokens?: number | undefined;
        readonly outputTokens?: number | undefined;
        readonly reasoningOutputTokens?: number | undefined;
      }
    | null
    | undefined,
  model: string | null = null,
): ContextReport | null {
  if (
    !usage ||
    !Number.isSafeInteger(usage.usedTokens) ||
    usage.usedTokens < 0 ||
    usage.maxTokens == null ||
    !Number.isSafeInteger(usage.maxTokens) ||
    usage.maxTokens <= 0
  ) {
    return null;
  }
  const freeTokens = Math.max(0, usage.maxTokens - usage.usedTokens);
  const usedPercent = (usage.usedTokens / usage.maxTokens) * 100;
  const reportedRows = REPORTED_USAGE_COUNTERS.flatMap(([key, label]) => {
    const value = usage[key];
    return value !== undefined && Number.isSafeInteger(value) && value >= 0
      ? [[label, value.toLocaleString("en-US")]]
      : [];
  });
  return {
    model,
    usedTokens: formatContextTokens(usage.usedTokens),
    maxTokens: formatContextTokens(usage.maxTokens),
    usedPercent,
    overLimit:
      usage.usedTokens > usage.maxTokens
        ? `${formatContextTokens(usage.usedTokens - usage.maxTokens)} tokens over`
        : null,
    categories: [
      { name: "Used context", tokens: formatContextTokens(usage.usedTokens), percent: usedPercent },
      {
        name: "Free space",
        tokens: formatContextTokens(freeTokens),
        percent: (freeTokens / usage.maxTokens) * 100,
      },
    ],
    sections: [
      {
        title: "Exact token counts",
        columns: ["Category", "Tokens"],
        rows: [
          ["Used context", usage.usedTokens.toLocaleString("en-US")],
          ["Free space", freeTokens.toLocaleString("en-US")],
          ["Context window", usage.maxTokens.toLocaleString("en-US")],
        ],
        totalTokens: null,
      },
      ...(reportedRows.length > 0
        ? [
            {
              title: "Reported usage",
              columns: ["Counter", "Tokens"],
              rows: reportedRows,
              totalTokens: null,
            },
          ]
        : []),
    ],
  };
}

export function latestContextReport(
  messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
  }>,
): { readonly id: string; readonly report: ContextReport } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return null;
    if (message.role !== "assistant" || message.streaming) continue;
    const report = parseClaudeContextReport(message.text);
    if (report) return { id: message.id, report };
  }
  return null;
}

export function formatContextHeadline(report: ContextReport): string {
  return `${report.usedTokens} / ${report.maxTokens} (${formatContextPercent(report.usedPercent)})`;
}

export function contextUsedCategories(report: ContextReport): ReadonlyArray<ContextCategory> {
  return report.categories.filter((category) => !FREE_SPACE_CATEGORIES.has(category.name));
}

export function formatContextPercent(value: number): string {
  return value < 10 ? `${value.toFixed(1).replace(/\.0$/u, "")}%` : `${Math.round(value)}%`;
}

export function formatContextTokens(value: number): string {
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 1_000_000) {
    const thousands = value / 1_000;
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/u, "") : Math.round(thousands)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
}

export function contextSegmentColor(index: number, count: number): string {
  if (count === 1) return "hsl(210 65% 58%)";
  return `hsl(${Math.round((index / Math.max(count, 1)) * 300)} 55% 58%)`;
}
