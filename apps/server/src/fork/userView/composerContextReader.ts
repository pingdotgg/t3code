import type {
  ComposerContextKind,
  ComposerContextRecord,
  KnownComposerContextRecord,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextProviderPayload,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";

/** Chips whose record holds words a person wrote or attached beyond the chip's label. */
const DETAIL_KINDS: ReadonlySet<ComposerContextKind> = new Set([
  "review-comment",
  "preview-annotation",
  "terminal",
  "element",
]);

const kindName = (kind: ComposerContextKind) => {
  const spaced = kind.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

/** What a chip's card shows beyond its label, without the provider form's instructions. */
function details(record: KnownComposerContextRecord): string | null {
  if (record.kind === "response")
    return [
      ...(record.subagents ?? []).map((subagent) => `about subagent: ${subagent.title}`),
      `response: ${record.citation.text}`,
    ].join("\n");
  if (record.kind === "thread")
    return `threadId: ${record.threadId}\nenvironmentId: ${record.environmentId}`;
  if (!DETAIL_KINDS.has(record.kind)) return null;
  // The screenshot ref names another chip's id, which a reader never sees.
  return formatComposerContextProviderPayload(record)
    .split("\n")
    .filter((line) => !line.startsWith("screenshot: ref="))
    .join("\n");
}

/**
 * A message's text as a person reads it: each chip as `[Kind: label]`, then the content of the
 * chips that carry more than their label. It has none of the provider form's agent instructions.
 */
export function composerContextTextForReader(input: {
  readonly text: string;
  readonly records: ReadonlyArray<ComposerContextRecord>;
}): string {
  const occurrences = collectComposerContextReferences(input.text);
  if (occurrences.length === 0) return input.text;
  const body = replaceComposerContextReferences(
    input.text,
    (occurrence) => `[${kindName(occurrence.kind)}: ${occurrence.label}]`,
  );
  const shown = new Set(occurrences.map((occurrence) => occurrence.contextId));
  const entries = input.records.flatMap((record) => {
    const detail = shown.has(record.contextId) && !("payload" in record) ? details(record) : null;
    return detail === null
      ? []
      : [`[${kindName(record.kind)}: ${record.label}]\n${indent(detail)}`];
  });
  return [body, ...entries].join("\n\n");
}
