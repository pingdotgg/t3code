import * as NodeCrypto from "node:crypto";

import type { ExternalWorkItem } from "./Services/WorkSourceProvider.ts";
import type {
  SourceDelta,
  SourceItemFields,
  SourceItemMetadata,
} from "./Services/WorkflowSourceCommitter.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A row from `work_source_mapping` as required by the diff.
 * Only the columns the reconciler reads are declared here; the committer's
 * `readMapping` helper in Task 9 selects an equivalent superset.
 */
export interface MappingRow {
  readonly externalId: string;
  readonly ticketId: string;
  readonly contentHash: string;
  readonly providerVersion: string | null;
  readonly lifecycle: string; // 'open' | 'closed'
  readonly syncStatus: string; // 'active' | 'orphaned'
  // Canonical serialized metadata as last persisted (work_source_mapping
  // .source_metadata_json). Compared against the freshly-serialized item metadata
  // so a metadata-only upstream change (labels/assignees/url) is still synced even
  // when title/description (the content hash) are unchanged.
  readonly sourceMetadataJson: string | null;
}

export interface ClassifyDeltasInput {
  readonly sourceId: string;
  readonly provider: string;
  readonly items: ReadonlyArray<ExternalWorkItem>;
  /** All `work_source_mapping` rows for this (boardId, sourceId). */
  readonly mappings: ReadonlyArray<MappingRow>;
  /**
   * `true` when the provider returned all pages without hitting a page cap
   * or error. Only a complete scan may produce `missing` deltas — a partial
   * scan must never orphan items that simply weren't fetched yet.
   */
  readonly scanCompleted: boolean;
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic content hash of the upstream fields that are synced to the
 * ticket. Only `title` and `description` are authoritative (the committer's
 * version gate compares this against `work_source_mapping.content_hash`).
 *
 * Uses SHA-256 over canonical JSON so the hash is stable across runs.
 */
export const hashContent = (fields: {
  title: string;
  description?: string | undefined;
}): string => {
  // Source-owned descriptions are authoritative: a cleared/absent upstream
  // description normalizes to "" (NOT null) so the hash AND the carried value
  // agree. (An upstream item whose description was cleared must clear the
  // ticket's description, and the stored hash must reflect the cleared value
  // so the next no-change cycle is a no-op.)
  const canonical = JSON.stringify({ title: fields.title, description: fields.description ?? "" });
  return NodeCrypto.createHash("sha256").update(canonical).digest("hex");
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const buildMetadata = (item: ExternalWorkItem): SourceItemMetadata => ({
  provider: item.provider,
  url: item.url,
  assignees: item.fields.assignees,
  labels: item.fields.labels,
  lifecycle: item.lifecycle,
});

/**
 * Canonical serialization of a source item's metadata. MUST stay byte-identical
 * to what the committer persists into `work_source_mapping.source_metadata_json`
 * so the reconcile diff can compare the two strings to detect metadata-only
 * changes. The committer imports THIS function for its writes (single source of
 * truth — do not fork the shape).
 */
export const serializeSourceMetadata = (metadata: SourceItemMetadata): string =>
  JSON.stringify({
    provider: metadata.provider,
    url: metadata.url ?? null,
    assignees: metadata.assignees ?? [],
    labels: metadata.labels ?? [],
    lifecycle: metadata.lifecycle ?? null,
  });

export const buildSourceItemFields = (
  sourceId: string,
  item: ExternalWorkItem,
  contentHash: string,
): SourceItemFields => ({
  sourceId,
  provider: item.provider,
  externalId: item.externalId,
  title: item.fields.title,
  // Always carry the (possibly empty) description so the committer WRITES it —
  // a cleared upstream description must clear the ticket, not leave it stale.
  // "" is a valid clear; never carry undefined for a synced item.
  description: item.fields.description ?? "",
  contentHash,
  providerVersion: item.version.updatedAt ?? item.version.etag ?? undefined,
  metadata: buildMetadata(item),
});

/** Canonical `new` delta for a single item — used by curated import so its
 *  contentHash/metadata match the syncer's classify output exactly. */
export const buildNewSourceDelta = (sourceId: string, item: ExternalWorkItem): SourceDelta => ({
  _tag: "new",
  item: buildSourceItemFields(sourceId, item, hashContent(item.fields)),
});

/**
 * Reconstruct a minimal `SourceItemFields` from a mapping row for use in
 * `missing` deltas. The actual field values are not critical here — the
 * committer only uses `externalId`/`sourceId`/`provider` to find the row
 * in-tx; title/description/contentHash/metadata come from the stored mapping.
 */
const buildMissingFields = (
  sourceId: string,
  provider: string,
  row: MappingRow,
): SourceItemFields => ({
  sourceId,
  provider,
  externalId: row.externalId,
  title: "",
  description: undefined,
  contentHash: row.contentHash,
  providerVersion: row.providerVersion ?? undefined,
  metadata: { provider },
});

// ---------------------------------------------------------------------------
// Core classifier
// ---------------------------------------------------------------------------

/**
 * Pure reconcile diff — no IO.
 *
 * **Precedence rule (closed/deleted vs changed):**
 * If an item is both changed (hash differs) AND closed/deleted (lifecycle === "closed" | "deleted"),
 * we emit only `closed`. The committer already updates the mapping's
 * `content_hash` when processing a `closed` delta, so a subsequent run will
 * see no content delta. This keeps the committer logic simple and the user
 * sees the correct terminal routing immediately.
 *
 * **Ordering:**
 * Output follows the input `items` array order (new/changed/closed from
 * items) then missing (from mappings, in their original order). This is
 * deterministic and stable so tests can rely on ordering.
 *
 * **scan-completeness gate:**
 * `missing` deltas are only emitted when `scanCompleted === true`. A partial
 * or failed scan must never produce orphan deltas.
 */
export const classifyDeltas = (input: ClassifyDeltasInput): ReadonlyArray<SourceDelta> => {
  const { sourceId, provider, items, mappings, scanCompleted } = input;

  // Build an index of mappings by externalId for O(1) lookup.
  const mappingByExternalId = new Map<string, MappingRow>();
  for (const row of mappings) {
    mappingByExternalId.set(row.externalId, row);
  }

  // Track which externalIds were seen in the fetched items.
  const seenExternalIds = new Set<string>();

  const deltas: SourceDelta[] = [];

  for (const item of items) {
    seenExternalIds.add(item.externalId);
    const contentHash = hashContent(item.fields);
    const fields = buildSourceItemFields(sourceId, item, contentHash);
    const row = mappingByExternalId.get(item.externalId);

    if (row === undefined) {
      // No mapping → this is a new item.
      deltas.push({ _tag: "new", item: fields });
    } else {
      // Mapped item. Closed/deleted takes precedence over changed.
      const isTerminal = item.lifecycle === "closed" || item.lifecycle === "deleted";
      if (isTerminal && row.lifecycle !== "closed") {
        deltas.push({ _tag: "closed", item: fields, ticketId: row.ticketId });
      } else if (!isTerminal && (row.lifecycle === "closed" || row.syncStatus === "orphaned")) {
        // Item is OPEN upstream but its mapping is closed (previously source-
        // closed) or orphaned (previously went missing). Reopen/reactivate:
        // restore lifecycle/sync_status, route the ticket out of the closed lane,
        // and refresh content. Emitting this regardless of the content hash is
        // what unsticks an upstream reopen whose title/description did not change.
        deltas.push({ _tag: "reopened", item: fields, ticketId: row.ticketId });
      } else if (
        !isTerminal &&
        (contentHash !== row.contentHash ||
          serializeSourceMetadata(fields.metadata) !== row.sourceMetadataJson)
      ) {
        // Emit changed for open+active items whose CONTENT (title/description) or
        // METADATA (labels/assignees/url) differs from what is stored. Metadata is
        // surfaced as the ticket's syncedSource, so a metadata-only change must
        // still be persisted even though the content hash is unchanged.
        deltas.push({ _tag: "changed", item: fields, ticketId: row.ticketId });
      }
      // If hash === row.contentHash (or item is already closed in both places):
      // no delta — this is a no-op.
    }
  }

  // Missing deltas: mappings whose externalId was NOT in the fetched items.
  // Only emit when the scan was complete (all pages fetched without cap hit).
  if (scanCompleted) {
    for (const row of mappings) {
      if (!seenExternalIds.has(row.externalId) && row.syncStatus === "active") {
        const fields = buildMissingFields(sourceId, provider, row);
        deltas.push({
          _tag: "missing",
          item: fields,
          ticketId: row.ticketId,
          confirmedDeleted: false,
        });
      }
    }
  }

  return deltas;
};
