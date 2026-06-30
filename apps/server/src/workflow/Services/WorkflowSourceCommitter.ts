import type { BoardId, LaneKey } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

// Read-only display metadata captured from the external provider item. Serialized
// into `work_source_mapping.source_metadata_json` and surfaced by Task 13.
export interface SourceItemMetadata {
  readonly provider: string;
  readonly url?: string | undefined;
  readonly assignees?: ReadonlyArray<string> | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly lifecycle?: string | undefined;
}

// The external item fields a reconcile delta carries. These are the
// provider-derived values the committer writes to the ticket + mapping row.
export interface SourceItemFields {
  readonly sourceId: string;
  readonly provider: string;
  readonly externalId: string;
  readonly title: string;
  readonly description?: string | undefined;
  // Stable hash of the upstream content. The change/close gate compares this
  // against the stored mapping.content_hash so a re-run with no upstream change
  // writes nothing (idempotency).
  readonly contentHash: string;
  readonly providerVersion?: string | undefined;
  readonly metadata: SourceItemMetadata;
}

// A single per-item reconcile decision computed by the Task 10 diff (OUTSIDE the
// lock). The committer re-validates each one in-tx before applying it.
//
// - `new`:     unmapped upstream item → create ticket + mapping.
// - `changed`: mapped item whose content may differ → version-gated edit.
// - `closed`:  mapped item the provider reports terminal → source-aware close.
// - `reopened`: mapped item that is OPEN upstream but whose mapping is
//              closed/orphaned (it was previously source-closed or orphaned) →
//              restore lifecycle='open'/sync_status='active', route the ticket
//              out of the closed lane back into the destination lane, and refresh
//              its content. Without this an upstream reopen is stuck terminal.
// - `missing`: mapped item not seen in a COMPLETE scan → mark orphaned; if the
//              syncer (Task 11) confirmed deletion via a provider getItem call
//              (network OUT of this tx) it sets `confirmedDeleted` so the
//              committer also terminal-routes the ticket.
export type SourceDelta =
  | {
      readonly _tag: "new";
      readonly item: SourceItemFields;
    }
  | {
      readonly _tag: "changed";
      readonly item: SourceItemFields;
      // The mapping row as seen by the out-of-lock diff. The committer re-reads
      // by the unique key in-tx and uses the fresh row for the version gate.
      readonly ticketId: string;
    }
  | {
      readonly _tag: "reopened";
      readonly item: SourceItemFields;
      readonly ticketId: string;
    }
  | {
      readonly _tag: "closed";
      readonly item: SourceItemFields;
      readonly ticketId: string;
    }
  | {
      readonly _tag: "missing";
      readonly item: SourceItemFields;
      readonly ticketId: string;
      // Set true by the syncer only after a provider getItem confirms the item
      // is genuinely gone (404/closed), authorizing a terminal route here.
      readonly confirmedDeleted?: boolean | undefined;
    };

export interface ReconcileLanes {
  // Lane new tickets are admitted into.
  readonly destinationLane: LaneKey;
  // Terminal lane a source-driven close routes into.
  readonly closedLane: LaneKey;
}

export interface WorkflowSourceCommitterShape {
  // Apply a per-board batch ("chunk") of reconcile deltas to tickets + the
  // work_source_mapping table under admission(OUTER) -> save(INNER) ->
  // transaction (innermost), then trigger the board's auto-lane pipeline starts
  // AFTER the transaction commits. Idempotent. No network here.
  readonly reconcileChunk: (
    boardId: BoardId,
    lanes: ReconcileLanes,
    deltas: ReadonlyArray<SourceDelta>,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class WorkflowSourceCommitter extends Context.Service<
  WorkflowSourceCommitter,
  WorkflowSourceCommitterShape
>()("t3/workflow/Services/WorkflowSourceCommitter") {}
