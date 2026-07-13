import type { ChatAttachment, ComposerPayloadWeight } from "@t3tools/contracts";
import { estimateImageTokens, estimateTextTokens } from "@t3tools/shared/tokenAccounting";
import type { ElementContextSelection } from "./elementContext";
import { buildElementContextBlock } from "./elementContext";
import type { TerminalContextSelection } from "./terminalContext";
import { buildTerminalContextBlock } from "./terminalContext";
import type { ReviewCommentContext } from "../reviewCommentContext";
import { formatReviewCommentContext } from "../reviewCommentContext";

export const COMPOSER_EFFICIENCY_THRESHOLDS = {
  largeEstimatedInputTokens: 16_000,
  veryLargeEstimatedInputTokens: 40_000,
  hugeSingleSourceTokens: 8_000,
  contextWindowWarningRatio: 0.65,
  contextWindowDangerRatio: 0.85,
} as const;

export interface ComposerPayloadWeightInput {
  readonly prompt: string;
  readonly terminalContexts?: ReadonlyArray<TerminalContextSelection>;
  readonly elementContexts?: ReadonlyArray<ElementContextSelection>;
  readonly reviewComments?: ReadonlyArray<ReviewCommentContext>;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
}

function source(input: {
  readonly id: string;
  readonly label: string;
  readonly kind: ComposerPayloadWeight["sources"][number]["kind"];
  readonly text?: string;
  readonly estimatedChars?: number;
  readonly estimatedTokens?: number;
  readonly trimAvailable: boolean;
}): ComposerPayloadWeight["sources"][number] {
  const estimatedChars = input.estimatedChars ?? input.text?.length ?? 0;
  const estimatedTokens =
    input.estimatedTokens ?? estimateTextTokens({ text: input.text ?? "", contentKind: "mixed" });
  return {
    id: input.id,
    label: input.label,
    kind: input.kind,
    estimatedChars,
    estimatedTokens,
    trimAvailable: input.trimAvailable,
  };
}

export function estimateComposerPayloadWeight(
  input: ComposerPayloadWeightInput,
): ComposerPayloadWeight {
  const sources: Array<ComposerPayloadWeight["sources"][number]> = [];
  const prompt = input.prompt.trim();
  if (prompt.length > 0) {
    sources.push(
      source({
        id: "prompt",
        label: "Prompt",
        kind: "prompt",
        text: prompt,
        trimAvailable: false,
      }),
    );
  }

  for (const [index, context] of (input.terminalContexts ?? []).entries()) {
    const text = buildTerminalContextBlock([context]);
    if (text.length === 0) continue;
    sources.push(
      source({
        id: `terminal:${context.terminalId || index}`,
        label: context.terminalLabel || `Terminal context ${index + 1}`,
        kind: "terminal_context",
        text,
        trimAvailable: true,
      }),
    );
  }

  for (const [index, context] of (input.elementContexts ?? []).entries()) {
    const text = buildElementContextBlock([context]);
    if (text.length === 0) continue;
    sources.push(
      source({
        id: `element:${context.selector ?? context.componentName ?? index}`,
        label: context.componentName ?? context.selector ?? `Element context ${index + 1}`,
        kind: "element_context",
        text,
        trimAvailable: true,
      }),
    );
  }

  for (const [index, comment] of (input.reviewComments ?? []).entries()) {
    const text = formatReviewCommentContext(comment);
    sources.push(
      source({
        id: `review:${comment.id || index}`,
        label: comment.filePath || `Review comment ${index + 1}`,
        kind: "review_comment",
        text,
        trimAvailable: true,
      }),
    );
  }

  for (const [index, attachment] of (input.attachments ?? []).entries()) {
    sources.push(
      source({
        id: `image:${attachment.id || index}`,
        label: attachment.name || `Image ${index + 1}`,
        kind: "image",
        estimatedChars: 0,
        estimatedTokens: estimateImageTokens({
          sizeBytes: attachment.sizeBytes,
          mimeType: attachment.mimeType,
        }),
        trimAvailable: true,
      }),
    );
  }

  return {
    estimatedTokens: sources.reduce((sum, entry) => sum + entry.estimatedTokens, 0),
    estimatedChars: sources.reduce((sum, entry) => sum + entry.estimatedChars, 0),
    sources,
  };
}
