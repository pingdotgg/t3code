import { LocationContextRecord, type OrchestrationMessageContext } from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { normalizeSharedLocationMessage } from "@t3tools/shared/sharedLocation";
import * as Schema from "effect/Schema";

import type { DraftComposerLocationAttachment } from "./sharedLocation";

const isLocationRecord = Schema.is(LocationContextRecord);

/** Split location cards from prose while retaining other inline context and its bindings. */
export function separateComposerLocationContext(input: {
  readonly text: string;
  readonly context?: OrchestrationMessageContext;
}) {
  const normalized = normalizeSharedLocationMessage(input);
  const referencedIds = new Set(
    collectComposerContextReferences(normalized.text).map((ref) => ref.contextId),
  );
  const records = normalized.context?.records ?? [];
  const locationRecords = records
    .filter(isLocationRecord)
    .filter((record) => referencedIds.has(record.contextId));
  const locationIds = new Set(locationRecords.map((record) => record.contextId));
  const text = replaceComposerContextReferences(normalized.text, (ref) =>
    locationIds.has(ref.contextId) ? "" : ref.source,
  ).trimEnd();
  const remaining = records.filter((record) => !isLocationRecord(record));
  return {
    text,
    context: remaining.length > 0 ? { version: 1 as const, records: remaining } : undefined,
    messageContext: normalized.context,
    locations: locationRecords.map((record): DraftComposerLocationAttachment => ({
      ...record.payload,
      id: record.contextId,
      type: "location",
    })),
  };
}
