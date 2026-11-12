import { diffLines } from "diff";
import type { Beat } from "../../shared/types.ts";

type Edit = Extract<Beat, { kind: "editor.edit" }>;

const lines = (value: string) => {
  const out = value.split("\n");
  if (out.at(-1) === "") out.pop();
  return out;
};

type Op = { kind: "same" | "del" | "add"; lines: string[] };

/** Unchanged lines that may sit inside one added block without splitting it. */
const GAP = 2;

/**
 * One recorded edit as the steps you'd make by hand, one keypress each: first
 * remove the code that goes away, then add each new block, top to bottom (so a
 * binding is declared before the code that uses it). A block that only rewrites
 * lines in place (same number of lines out and in) is edited in its own step.
 */
export const splitEdit = (beat: Edit): Edit[] => {
  const ops: Op[] = diffLines(beat.before, beat.after).map((part) => ({
    kind: part.added ? "add" : part.removed ? "del" : "same",
    lines: lines(part.value),
  }));
  // A removal directly followed by an addition of the same size is a rewrite.
  const rewrite = new Set<number>();
  ops.forEach((op, i) => {
    const next = ops[i + 1];
    if (op.kind === "del" && next?.kind === "add" && next.lines.length === op.lines.length) {
      rewrite.add(i);
      rewrite.add(i + 1);
    }
  });
  // Changes to apply after the removals, grouped into blocks.
  const groups: number[][] = [];
  let lastChange = -Infinity;
  let gap = 0;
  ops.forEach((op, i) => {
    if (op.kind === "same") {
      gap += op.lines.length;
      return;
    }
    if (op.kind === "del" && !rewrite.has(i)) return;
    if (groups.length && gap <= GAP && lastChange >= 0) groups.at(-1)!.push(i);
    else groups.push([i]);
    lastChange = i;
    gap = 0;
  });
  // Import lines arrive with the code that needs them, not as steps of their own.
  const isImports = (group: number[]) =>
    group.every(
      (i) => ops[i]!.kind !== "add" || ops[i]!.lines.every((l) => /^\s*(import\b|$)/.test(l)),
    );
  for (let g = groups.length - 2; g >= 0; g--) {
    if (isImports(groups[g]!)) groups.splice(g, 2, [...groups[g]!, ...groups[g + 1]!]);
  }
  const removals = ops.some((op, i) => op.kind === "del" && !rewrite.has(i));
  const stages = (removals ? 1 : 0) + groups.length;
  if (stages <= 1) return [beat];

  // The file once removals and the first `n` groups are applied.
  const textAt = (n: number) => {
    const applied = new Set(groups.slice(0, n).flat());
    const out: string[] = [];
    ops.forEach((op, i) => {
      if (op.kind === "same") out.push(...op.lines);
      else if (op.kind === "add" && applied.has(i)) out.push(...op.lines);
      else if (op.kind === "del" && rewrite.has(i) && !applied.has(i + 1)) out.push(...op.lines);
    });
    return `${out.join("\n")}\n`;
  };
  const texts = [
    beat.before,
    ...(removals ? [textAt(0)] : []),
    ...groups.map((_, g) => textAt(g + 1)),
  ];
  texts[texts.length - 1] = beat.after;
  const edits: Edit[] = [];
  for (let k = 1; k < texts.length; k++) {
    if (texts[k] !== texts[k - 1]) edits.push({ ...beat, before: texts[k - 1]!, after: texts[k]! });
  }
  return edits.length ? edits : [beat];
};

/** Every recorded edit in a scene, split into hand-sized steps. */
export const splitEdits = (beats: readonly Beat[]): Beat[] =>
  beats.flatMap((beat): Beat[] => (beat.kind === "editor.edit" ? splitEdit(beat) : [beat]));
