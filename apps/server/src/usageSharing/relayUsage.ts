export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Token counts from one JSON body or SSE event of the Anthropic, Responses, or Chat APIs. */
function usageFromEvent(event: unknown): TokenUsage | null {
  if (typeof event !== "object" || event === null) return null;
  const record = event as Record<string, unknown>;
  // Responses API streams the totals on `response.completed`.
  const response = record.response as Record<string, unknown> | undefined;
  const usage = (record.usage ??
    response?.usage ??
    (record.message as Record<string, unknown> | undefined)?.usage) as
    | Record<string, unknown>
    | undefined;
  if (!usage) return null;
  return {
    inputTokens:
      number(usage.input_tokens) +
      number(usage.prompt_tokens) +
      number(usage.cache_creation_input_tokens) +
      number(usage.cache_read_input_tokens),
    outputTokens: number(usage.output_tokens) + number(usage.completion_tokens),
  };
}

/**
 * Collects token usage from a relayed response as it streams by. Anthropic sends input on
 * `message_start` and running output totals on `message_delta`; OpenAI-style APIs send one final
 * usage object. Each kind is kept as the largest value seen, so repeats are not double counted.
 */
export class RelayUsageMeter {
  private buffer = "";
  private inputTokens = 0;
  private outputTokens = 0;
  private sawUsage = false;

  private readonly streaming: boolean;

  constructor(streaming: boolean) {
    this.streaming = streaming;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    if (!this.streaming) return;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.startsWith("data:")) this.read(line.slice(5).trim());
      newline = this.buffer.indexOf("\n");
    }
    // A stream never needs more than one partial line in memory.
    if (this.buffer.length > 1_000_000) this.buffer = "";
  }

  finish(): { readonly usage: TokenUsage; readonly measured: boolean } {
    if (this.streaming) {
      if (this.buffer.trim().startsWith("data:")) this.read(this.buffer.trim().slice(5).trim());
    } else {
      this.read(this.buffer);
    }
    this.buffer = "";
    return {
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      measured: this.sawUsage,
    };
  }

  private read(text: string): void {
    if (text === "" || text === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const usage = usageFromEvent(parsed);
    if (usage === null) return;
    this.sawUsage = true;
    this.inputTokens = Math.max(this.inputTokens, usage.inputTokens);
    this.outputTokens = Math.max(this.outputTokens, usage.outputTokens);
  }
}
