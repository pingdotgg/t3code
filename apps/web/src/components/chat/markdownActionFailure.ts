export type TableCopyFormat = "markdown" | "csv" | "html";

interface MarkdownActionFailureContext {
  readonly operation: string;
  readonly target?: string;
  readonly format?: TableCopyFormat;
  readonly language?: string;
  readonly fenceTitle?: string;
  readonly copyTarget?: string;
}

export function reportMarkdownActionFailure(
  context: MarkdownActionFailureContext,
  cause: unknown,
): void {
  console.error("[chat-markdown] action failed", context, cause);
}
