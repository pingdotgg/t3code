import { resolveHighlightLanguage } from "../../lib/highlightLanguage";
import { highlightCode, type HighlightScheme } from "../../lib/highlights";
import type { ReviewHighlightedToken } from "./reviewHighlightedToken.types";
import type { ReviewRenderableLineRow } from "./reviewModel";
import { applyDiffRangesToTokens, computeWordAltDiffRanges } from "./reviewWordDiffs";

function applyWordAltDiffHighlightsToSelectedLines(input: {
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly tokenMap: Record<string, ReadonlyArray<ReviewHighlightedToken>>;
}): Record<string, ReadonlyArray<ReviewHighlightedToken>> {
  const additionLineByTokenIndex = new Map<number, ReviewRenderableLineRow>();
  const deletionLineByTokenIndex = new Map<number, ReviewRenderableLineRow>();

  input.lines.forEach((line) => {
    if (line.change === "add" && line.additionTokenIndex !== null) {
      additionLineByTokenIndex.set(line.additionTokenIndex, line);
    }
    if (line.change === "delete" && line.deletionTokenIndex !== null) {
      deletionLineByTokenIndex.set(line.deletionTokenIndex, line);
    }
  });

  const nextTokenMap = { ...input.tokenMap };
  const processedPairs = new Set<string>();

  input.lines.forEach((line) => {
    if (line.change === "context" || !line.comparison) {
      return;
    }

    const pairedDeletionLine =
      line.change === "delete"
        ? line
        : line.comparison.change === "delete"
          ? deletionLineByTokenIndex.get(line.comparison.tokenIndex)
          : undefined;
    const pairedAdditionLine =
      line.change === "add"
        ? line
        : line.comparison.change === "add"
          ? additionLineByTokenIndex.get(line.comparison.tokenIndex)
          : undefined;

    if (
      !pairedDeletionLine ||
      !pairedAdditionLine ||
      pairedDeletionLine.deletionTokenIndex === null ||
      pairedAdditionLine.additionTokenIndex === null
    ) {
      return;
    }

    const pairKey = `${pairedDeletionLine.deletionTokenIndex}:${pairedAdditionLine.additionTokenIndex}`;
    if (processedPairs.has(pairKey)) {
      return;
    }
    processedPairs.add(pairKey);

    const ranges = computeWordAltDiffRanges({
      deletionLine: pairedDeletionLine.content,
      additionLine: pairedAdditionLine.content,
    });

    if (ranges.deletion.length > 0) {
      nextTokenMap[pairedDeletionLine.id] = applyDiffRangesToTokens(
        nextTokenMap[pairedDeletionLine.id] ?? [],
        ranges.deletion,
      );
    }
    if (ranges.addition.length > 0) {
      nextTokenMap[pairedAdditionLine.id] = applyDiffRangesToTokens(
        nextTokenMap[pairedAdditionLine.id] ?? [],
        ranges.addition,
      );
    }
  });

  return nextTokenMap;
}

export function highlightReviewSelectedLines(input: {
  readonly filePath: string;
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly theme: HighlightScheme;
}): Record<string, ReadonlyArray<ReviewHighlightedToken>> {
  if (input.lines.length === 0) {
    return {};
  }

  // Deleted and added lines each read as their own continuous source.
  const language = resolveHighlightLanguage({ path: input.filePath });
  const deletionLines = input.lines.filter((line) => line.change === "delete");
  const additionLikeLines = input.lines.filter((line) => line.change !== "delete");
  const highlightSide = (lines: ReadonlyArray<ReviewRenderableLineRow>) =>
    highlightCode(lines.map((line) => line.content).join("\n"), language, input.theme);
  const deletionTokens = highlightSide(deletionLines);
  const additionTokens = highlightSide(additionLikeLines);

  const tokenMap: Record<string, ReadonlyArray<ReviewHighlightedToken>> = {};
  deletionLines.forEach((line, index) => {
    tokenMap[line.id] = deletionTokens[index] ?? [];
  });
  additionLikeLines.forEach((line, index) => {
    tokenMap[line.id] = additionTokens[index] ?? [];
  });

  return applyWordAltDiffHighlightsToSelectedLines({
    lines: input.lines,
    tokenMap,
  });
}
