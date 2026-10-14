import {
  type GenerationSpeed,
  type GenerationSpeedMeasurement,
  type ModelSelection,
  type UsageProviderKind,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

export function generationSpeedMeasurement(
  speed: GenerationSpeed | undefined,
  selection: ModelSelection,
  provider: UsageProviderKind,
): GenerationSpeedMeasurement | undefined {
  if (speed === undefined) return undefined;
  const reasoningEffort =
    getModelSelectionStringOptionValue(selection, "reasoningEffort") ??
    getModelSelectionStringOptionValue(selection, "effort");
  const serviceTier = getModelSelectionStringOptionValue(selection, "serviceTier");
  return {
    ...speed,
    provider,
    model: selection.model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
  };
}

/** Accumulates matched token counts and generation intervals, never turn duration. */
export class GenerationSpeedAccumulator {
  private outputTokens = 0;
  private durationMs = 0;
  private responses = 0;
  private startedAtMs: number | undefined;

  add(outputTokens: number, startedAtMs: number, completedAtMs: number): void {
    const durationMs = completedAtMs - startedAtMs;
    // Buffered or single-frame responses cannot establish a useful streaming rate.
    if (
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 2 ||
      !Number.isSafeInteger(startedAtMs) ||
      !Number.isSafeInteger(completedAtMs) ||
      durationMs < 100
    )
      return;
    this.outputTokens += outputTokens;
    this.durationMs += durationMs;
    this.responses += 1;
    this.startedAtMs = Math.min(this.startedAtMs ?? startedAtMs, startedAtMs);
  }

  summary(): GenerationSpeed | undefined {
    if (this.startedAtMs === undefined) return undefined;
    return {
      outputTokens: this.outputTokens,
      durationMs: this.durationMs,
      responses: this.responses,
      // @effect-diagnostics-next-line globalDate:off -- formats a supplied provider timestamp.
      startedAt: new Date(this.startedAtMs).toISOString(),
    };
  }
}

/** Codex gives native output-item timestamps and a usage report after each model response. */
export class CodexGenerationSpeed {
  private readonly totals = new GenerationSpeedAccumulator();
  private start: number | undefined;
  private end: number | undefined;
  private hasReasoning = false;
  private toolStarted = false;

  startItem(type: string, atMs: number): void {
    if (type === "reasoning" || type === "agentMessage" || type === "plan") {
      if (this.toolStarted) return;
      this.start = Math.min(this.start ?? atMs, atMs);
      this.hasReasoning ||= type === "reasoning";
    } else if (
      this.start !== undefined &&
      !this.toolStarted &&
      [
        "commandExecution",
        "fileChange",
        "mcpToolCall",
        "dynamicToolCall",
        "collabAgentToolCall",
        "subAgentActivity",
        "webSearch",
      ].includes(type)
    ) {
      // Codex can report usage after executing tools. Close at the first tool's
      // start so approvals and execution never become generation time.
      this.pause(atMs);
    }
  }

  pause(atMs: number): void {
    if (this.start === undefined || this.toolStarted) return;
    this.end = atMs;
    this.toolStarted = true;
  }

  completeItem(type: string, atMs: number): void {
    if (!this.toolStarted && (type === "reasoning" || type === "agentMessage" || type === "plan")) {
      this.end = Math.max(this.end ?? atMs, atMs);
    }
  }

  completeResponse(outputTokens: number, reasoningTokens: number): void {
    if (outputTokens <= 0) return;
    // Hidden reasoning without a matching lifecycle would inflate the rate.
    if (
      this.start !== undefined &&
      this.end !== undefined &&
      (reasoningTokens === 0 || this.hasReasoning)
    ) {
      this.totals.add(outputTokens, this.start, this.end);
    }
    this.start = undefined;
    this.end = undefined;
    this.hasReasoning = false;
    this.toolStarted = false;
  }

  summary(): GenerationSpeed | undefined {
    return this.totals.summary();
  }
}

/** Claude's stream reports initial and final output counts for each message. */
export class ClaudeGenerationSpeed {
  private readonly totals = new GenerationSpeedAccumulator();
  private current: { start: number; end: number | undefined; initialTokens: number } | undefined;

  startResponse(atMs: number, initialTokens: number): void {
    this.current = { start: atMs, end: undefined, initialTokens };
  }

  contentDelta(atMs: number): void {
    if (this.current !== undefined) this.current.end = atMs;
  }

  completeResponse(outputTokens: number): void {
    if (this.current?.end !== undefined) {
      this.totals.add(
        outputTokens - this.current.initialTokens,
        this.current.start,
        this.current.end,
      );
    }
    this.current = undefined;
  }

  summary(): GenerationSpeed | undefined {
    return this.totals.summary();
  }
}
