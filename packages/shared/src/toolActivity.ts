import type { ToolLifecycleItemType } from "@t3tools/contracts";
import {
  asTrimmedString,
  deriveToolPresentation,
  stripTrailingExitCode,
} from "./toolPresentation.ts";

/**
 * Flat `{ summary, detail }` view of a tool invocation, used by the ACP
 * runtime model to fill an ACP tool call's title/detail. It is a projection of
 * the typed `ToolPresentation` (see `./toolPresentation.ts`) — the extraction
 * and classification rules live there, not here.
 */

function normalizeEquivalentValue(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:complete|completed|started)\s*$/iu, "")
    .trim();
}

function isEquivalent(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeEquivalentValue(left)?.toLowerCase();
  const normalizedRight = normalizeEquivalentValue(right)?.toLowerCase();
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
}

export interface ToolActivityPresentation {
  readonly summary: string;
  readonly detail?: string | undefined;
}

export function deriveToolActivityPresentation(
  input: ToolActivityPresentationInput,
): ToolActivityPresentation {
  const title = asTrimmedString(input.title);
  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const fallbackSummary = asTrimmedString(input.fallbackSummary) ?? "Tool";

  const presentation = deriveToolPresentation({
    itemType: input.itemType,
    title: input.title,
    detail: input.detail,
    data: input.data,
  });

  switch (presentation.surface) {
    case "command":
    case "file_read":
    case "file_change":
      return {
        summary: presentation.title,
        ...(presentation.subtitle ? { detail: presentation.subtitle } : {}),
      };
    case "file_search":
    case "web_search":
      return {
        summary: "Searched files",
        ...(presentation.subtitle ? { detail: presentation.subtitle } : {}),
      };
    default:
      break;
  }

  // Generic fallback: keep the provider's own title, and only surface a detail
  // line when it says something the summary does not.
  if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
    return {
      summary: title ?? fallbackSummary,
      detail,
    };
  }

  return {
    summary: title ?? fallbackSummary,
  };
}
