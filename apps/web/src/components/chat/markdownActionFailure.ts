interface MarkdownActionFailureContext {
  readonly operation: string;
  readonly target?: string;
  readonly format?: "markdown" | "csv";
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
