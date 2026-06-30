import type { WorkflowDefinitionEncoded } from "@t3tools/contracts";
import { useMemo } from "react";

import { canonicalizeDefinitionJson } from "~/workflow/editorModel";

type DiffLineKind = "context" | "removed" | "added";

interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

export interface DiffViewProps {
  readonly currentDefinition: WorkflowDefinitionEncoded;
  readonly versionDefinition: WorkflowDefinitionEncoded;
}

export function DiffView({ currentDefinition, versionDefinition }: DiffViewProps) {
  const diffLines = useMemo(
    () =>
      diffCanonicalJson(
        canonicalizeDefinitionJson(versionDefinition),
        canonicalizeDefinitionJson(currentDefinition),
      ),
    [currentDefinition, versionDefinition],
  );
  const keyedDiffLines = useMemo(() => addDiffLineKeys(diffLines), [diffLines]);

  if (diffLines.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        No changes in canonical JSON.
      </div>
    );
  }

  return (
    <pre
      aria-label="Version diff"
      className="max-h-80 overflow-auto rounded-md border border-border bg-background p-3 text-xs leading-5 text-foreground"
    >
      {keyedDiffLines.map((line) => (
        <div
          key={line.key}
          className={
            line.kind === "added"
              ? "bg-success/10 text-success-foreground"
              : line.kind === "removed"
                ? "bg-destructive/10 text-destructive"
                : "text-muted-foreground"
          }
        >
          {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
          {line.text}
        </div>
      ))}
    </pre>
  );
}

export function diffCanonicalJson(
  versionJson: string,
  currentJson: string,
): ReadonlyArray<DiffLine> {
  const versionLines = splitLines(versionJson);
  const currentLines = splitLines(currentJson);
  if (arraysEqual(versionLines, currentLines)) {
    return [];
  }

  const lengths = Array.from({ length: versionLines.length + 1 }, () =>
    Array<number>(currentLines.length + 1).fill(0),
  );
  for (let left = versionLines.length - 1; left >= 0; left -= 1) {
    for (let right = currentLines.length - 1; right >= 0; right -= 1) {
      lengths[left]![right] =
        versionLines[left] === currentLines[right]
          ? lengths[left + 1]![right + 1]! + 1
          : Math.max(lengths[left + 1]![right]!, lengths[left]![right + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let left = 0;
  let right = 0;
  while (left < versionLines.length && right < currentLines.length) {
    if (versionLines[left] === currentLines[right]) {
      lines.push({ kind: "context", text: versionLines[left]! });
      left += 1;
      right += 1;
    } else if (lengths[left + 1]![right]! >= lengths[left]![right + 1]!) {
      lines.push({ kind: "removed", text: versionLines[left]! });
      left += 1;
    } else {
      lines.push({ kind: "added", text: currentLines[right]! });
      right += 1;
    }
  }
  while (left < versionLines.length) {
    lines.push({ kind: "removed", text: versionLines[left]! });
    left += 1;
  }
  while (right < currentLines.length) {
    lines.push({ kind: "added", text: currentLines[right]! });
    right += 1;
  }
  return lines;
}

const splitLines = (value: string): ReadonlyArray<string> => {
  const lines = value.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
};

const arraysEqual = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((line, index) => line === right[index]);

const addDiffLineKeys = (lines: ReadonlyArray<DiffLine>) => {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const baseKey = `${line.kind}:${line.text}`;
    const count = (seen.get(baseKey) ?? 0) + 1;
    seen.set(baseKey, count);
    return { ...line, key: `${baseKey}:${count}` };
  });
};
