/**
 * The report a conversation is about, carried on its first message the way
 * terminal and element selections are: appended as a tagged block after what
 * the person typed, and lifted back out when the message renders.
 *
 * The agent still reads the whole report. The reader sees a chip. Before
 * this, the rendered report was prepended to their first message, so the
 * thing they wrote arrived underneath a page of markdown they did not write.
 */

const TRAILING_REPORT_CONTEXT_BLOCK_PATTERN =
  /\n*<report_context title="([^"]*)">\n([\s\S]*?)\n<\/report_context>\s*$/;

export interface ReportContext {
  /** What the chip reads, and what the tooltip is titled. */
  readonly title: string;
  /** The report rendered as markdown: what the agent actually reads. */
  readonly markdown: string;
}

export interface ExtractedReportContext {
  /** The message without its report block. */
  readonly promptText: string;
  readonly context: ReportContext | null;
}

/** Quotes cannot survive the title attribute, so they leave as single ones. */
function escapeTitle(title: string): string {
  return title.replace(/\r?\n/g, " ").replace(/"/g, "'").trim();
}

export function buildReportContextBlock(context: ReportContext): string {
  // Trimmed, not just newline-stripped: a report that is only whitespace is
  // no report, and an empty block would still cost the message a chip.
  const markdown = context.markdown.replace(/\r\n/g, "\n").trim();
  if (markdown.length === 0) return "";
  return `<report_context title="${escapeTitle(context.title)}">\n${markdown}\n</report_context>`;
}

/**
 * Appends rather than prepends: the person's own words open the message, and
 * the report follows as context. Sending nothing but a report is still a
 * message worth sending — it is how "Implement it" opens a conversation.
 */
export function appendReportContextToPrompt(prompt: string, context: ReportContext): string {
  const block = buildReportContextBlock(context);
  const trimmed = prompt.trim();
  if (block.length === 0) return trimmed;
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}

export function extractTrailingReportContext(prompt: string): ExtractedReportContext {
  const match = TRAILING_REPORT_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) return { promptText: prompt, context: null };
  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/, ""),
    context: { title: match[1] ?? "Report", markdown: match[2] ?? "" },
  };
}
