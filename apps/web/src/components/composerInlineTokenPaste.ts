import { ComposerContextId } from "@t3tools/contracts";
import type {
  ComposerContextClipboardFragment,
  ComposerContextRecord,
  LocationContextRecord,
} from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextFragment,
  decodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  isLocationContextRecord,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { serializeSharedLocation } from "@t3tools/shared/sharedLocation";
/** Clipboard records referenced by the copied text, including dependent screenshots. */
export function readPastedComposerContext(
  clipboardData: Pick<DataTransfer, "getData">,
): ComposerContextClipboardFragment | null {
  const pastedText = clipboardData.getData("text/plain");
  // Only records whose links are in the pasted text get imported; a fragment may carry
  // more (it was built for a larger copy) and must not start transfers for those.
  const decodedFragment =
    decodeComposerContextFragment(clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)) ??
    decodeComposerContextClipboardHtml(clipboardData.getData("text/html"));
  if (decodedFragment === null) return null;
  const pastedIds = new Set<string>(
    collectComposerContextReferences(pastedText).map((occurrence) => occurrence.contextId),
  );
  for (const record of decodedFragment.records) {
    if (
      record.kind === "preview-annotation" &&
      !("payload" in record) &&
      pastedIds.has(record.contextId) &&
      record.screenshotContextId
    ) {
      pastedIds.add(record.screenshotContextId);
    }
  }
  return {
    ...decodedFragment,
    records: decodedFragment.records.filter((record) => pastedIds.has(record.contextId)),
  };
}

/** Expand pasted/stashed typed locations into the portable text form understood by every host. */
export function expandLocationContextReferences(
  text: string,
  records: ReadonlyArray<ComposerContextRecord>,
): string {
  const referencedIds = new Set(
    collectComposerContextReferences(text)
      .filter((occurrence) => occurrence.kind === "location")
      .map((occurrence) => occurrence.contextId),
  );
  if (referencedIds.size === 0) return text;

  // A clipboard can contain duplicate ids even though an orchestration context cannot. Keep
  // identical duplicates usable, but leave an ambiguous reference intact instead of choosing
  // one location payload arbitrarily.
  const locations = new Map<string, LocationContextRecord | null>();
  for (const record of records) {
    if (!isLocationContextRecord(record) || !referencedIds.has(record.contextId)) continue;
    if (!locations.has(record.contextId)) {
      locations.set(record.contextId, record);
      continue;
    }
    const existing = locations.get(record.contextId);
    if (
      existing &&
      serializeSharedLocation(existing.payload) !== serializeSharedLocation(record.payload)
    ) {
      locations.set(record.contextId, null);
    }
  }

  const emitted = new Set<string>();
  return replaceComposerContextReferences(text, (occurrence) => {
    if (occurrence.kind !== "location") return occurrence.source;
    const record = locations.get(occurrence.contextId);
    if (!record) return occurrence.source;
    // Keep a repeated mention readable without inserting a duplicate location snapshot.
    if (emitted.has(occurrence.contextId)) return occurrence.label;
    emitted.add(occurrence.contextId);
    return `\n${serializeSharedLocation(record.payload)}\n`;
  });
}

/** Imports the same structured clipboard payload for focused paste and paste-to-focus. */
export function importPastedComposerText(
  clipboardData: Pick<DataTransfer, "getData">,
  importContextFragment?: (
    fragment: ComposerContextClipboardFragment,
  ) => ReadonlyMap<string, string>,
): string {
  const pastedText = clipboardData.getData("text/plain");
  const fragment = readPastedComposerContext(clipboardData);
  const textWithLocations = fragment
    ? expandLocationContextReferences(pastedText, fragment.records)
    : pastedText;
  const importableFragment = fragment
    ? { ...fragment, records: fragment.records.filter((record) => record.kind !== "location") }
    : null;
  const rewrittenIds =
    importContextFragment && importableFragment && importableFragment.records.length > 0
      ? importContextFragment(importableFragment)
      : null;
  const text =
    rewrittenIds && rewrittenIds.size > 0
      ? replaceComposerContextReferences(textWithLocations, (occurrence) => {
          const nextId = rewrittenIds.get(occurrence.contextId);
          return nextId
            ? formatComposerContextReference({
                ...occurrence,
                contextId: ComposerContextId.make(nextId),
                kind: occurrence.kind === "element" ? "preview-annotation" : occurrence.kind,
              })
            : occurrence.source;
        })
      : textWithLocations;
  return text;
}
