import { WORKFLOW_WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  type AtomCommandConcurrency,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { applyBoardStreamItem, emptyBoardState, type BoardState } from "./boardState.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

// Board mutations serialize per environment so optimistic moves/edits apply in
// submission order against the streamed snapshot.
const serialPerEnv: AtomCommandConcurrency<{ readonly environmentId: string }> = {
  mode: "serial",
  key: ({ environmentId }) => environmentId,
};

/**
 * Workflow-board environment atoms — the @effect/atom replacement for the old
 * `readEnvironmentApi(env).workflow.*` facade. Mirrors the structure of
 * `createVcsEnvironmentAtoms` / `createSourceControlEnvironmentAtoms`:
 *   - queries  → `createEnvironmentRpcQueryAtomFamily` (unary reads)
 *   - commands → `createEnvironmentRpcCommand` (mutations; board-scoped
 *                mutations run serially per environment to preserve order)
 *   - board    → `createEnvironmentRpcSubscriptionAtomFamily` folding the
 *                BoardStreamItem stream through the pure `applyBoardStreamItem`
 *                reducer into an accumulated `BoardState`.
 *
 * Every member is keyed by `{ environmentId, input }` — the env replaces the
 * old `readEnvironmentApi(envId)` lookup. Each `createEnvironmentRpc*` call is
 * written out per-method (not via a shared helper) so the specific RPC tag's
 * input/output types are inferred at each call site.
 */
export function createWorkflowEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    // ── board live state (subscription, folded into BoardState) ──────────────
    board: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:workflow:board",
      tag: WORKFLOW_WS_METHODS.subscribeBoard,
      transform: (stream) =>
        stream.pipe(
          Stream.mapAccum(() => emptyBoardState, (current: BoardState, item) => {
            const next = applyBoardStreamItem(current, item);
            return [next, [next]] as const;
          }),
        ),
    }),

    // Raw (unfolded) board stream — each emitted BoardStreamItem as-is. Used by
    // the EnvironmentApi facade bridge's `subscribeBoard`; the board route reads
    // the folded `board` atom above for rendering.
    boardRaw: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:workflow:board-raw",
      tag: WORKFLOW_WS_METHODS.subscribeBoard,
    }),

    // ── queries (unary reads) ────────────────────────────────────────────────
    listBoards: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:list-boards",
      tag: WORKFLOW_WS_METHODS.listBoards,
      staleTimeMs: 5_000,
    }),
    getBoard: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:get-board",
      tag: WORKFLOW_WS_METHODS.getBoard,
    }),
    getBoardDefinition: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:get-board-definition",
      tag: WORKFLOW_WS_METHODS.getBoardDefinition,
    }),
    listBoardVersions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:list-board-versions",
      tag: WORKFLOW_WS_METHODS.listBoardVersions,
    }),
    getBoardVersion: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:get-board-version",
      tag: WORKFLOW_WS_METHODS.getBoardVersion,
    }),
    getTicketDetail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:get-ticket-detail",
      tag: WORKFLOW_WS_METHODS.getTicketDetail,
    }),
    getTicketDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:get-ticket-diff",
      tag: WORKFLOW_WS_METHODS.getTicketDiff,
    }),
    listTicketArtifacts: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:list-ticket-artifacts",
      tag: WORKFLOW_WS_METHODS.listTicketArtifacts,
    }),
    getWebhookConfig: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:get-webhook-config",
      tag: WORKFLOW_WS_METHODS.getWebhookConfig,
    }),
    getBoardDigest: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:get-board-digest",
      tag: WORKFLOW_WS_METHODS.getBoardDigest,
    }),
    getBoardMetrics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:get-board-metrics",
      tag: WORKFLOW_WS_METHODS.getBoardMetrics,
    }),
    listNeedsAttentionTickets: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:list-needs-attention-tickets",
      tag: WORKFLOW_WS_METHODS.listNeedsAttentionTickets,
    }),
    listWorkSourceConnections: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:list-work-source-connections",
      tag: WORKFLOW_WS_METHODS.listWorkSourceConnections,
    }),
    listOutboundConnections: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:list-outbound-connections",
      tag: WORKFLOW_WS_METHODS.listOutboundConnections,
    }),
    listImportableWorkItems: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:list-importable-work-items",
      tag: WORKFLOW_WS_METHODS.listImportableWorkItems,
    }),
    listBoardTemplates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:list-board-templates",
      tag: WORKFLOW_WS_METHODS.listBoardTemplates,
    }),
    listBoardProposals: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:list-board-proposals",
      tag: WORKFLOW_WS_METHODS.listBoardProposals,
    }),
    getBoardProposal: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:get-board-proposal",
      tag: WORKFLOW_WS_METHODS.getBoardProposal,
    }),

    // ── commands (mutations) ─────────────────────────────────────────────────
    createBoard: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:create-board",
      tag: WORKFLOW_WS_METHODS.createBoard,
      concurrency: serialPerEnv,
    }),
    deleteBoard: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:delete-board",
      tag: WORKFLOW_WS_METHODS.deleteBoard,
      concurrency: serialPerEnv,
    }),
    renameBoard: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:rename-board",
      tag: WORKFLOW_WS_METHODS.renameBoard,
      concurrency: serialPerEnv,
    }),
    saveBoardDefinition: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:save-board-definition",
      tag: WORKFLOW_WS_METHODS.saveBoardDefinition,
      concurrency: serialPerEnv,
    }),
    importBoard: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:import-board",
      tag: WORKFLOW_WS_METHODS.importBoard,
      concurrency: serialPerEnv,
    }),
    createWorkflowBoard: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:create-workflow-board",
      tag: WORKFLOW_WS_METHODS.createWorkflowBoard,
      concurrency: serialPerEnv,
    }),
    generateWorkflowDraft: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:generate-workflow-draft",
      tag: WORKFLOW_WS_METHODS.generateWorkflowDraft,
      concurrency: serialPerEnv,
    }),
    createTicket: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:create-ticket",
      tag: WORKFLOW_WS_METHODS.createTicket,
      concurrency: serialPerEnv,
    }),
    editTicket: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:edit-ticket",
      tag: WORKFLOW_WS_METHODS.editTicket,
      concurrency: serialPerEnv,
    }),
    moveTicket: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:move-ticket",
      tag: WORKFLOW_WS_METHODS.moveTicket,
      concurrency: serialPerEnv,
    }),
    runLane: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:run-lane",
      tag: WORKFLOW_WS_METHODS.runLane,
      concurrency: serialPerEnv,
    }),
    resolveApproval: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:resolve-approval",
      tag: WORKFLOW_WS_METHODS.resolveApproval,
      concurrency: serialPerEnv,
    }),
    answerTicketStep: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:answer-ticket-step",
      tag: WORKFLOW_WS_METHODS.answerTicketStep,
      concurrency: serialPerEnv,
    }),
    postTicketMessage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:post-ticket-message",
      tag: WORKFLOW_WS_METHODS.postTicketMessage,
      concurrency: serialPerEnv,
    }),
    editTicketMessage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:edit-ticket-message",
      tag: WORKFLOW_WS_METHODS.editTicketMessage,
      concurrency: serialPerEnv,
    }),
    cancelStep: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:cancel-step",
      tag: WORKFLOW_WS_METHODS.cancelStep,
      concurrency: serialPerEnv,
    }),
    setProjectScriptTrust: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:set-project-script-trust",
      tag: WORKFLOW_WS_METHODS.setProjectScriptTrust,
      concurrency: serialPerEnv,
    }),
    intakeTickets: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:intake-tickets",
      tag: WORKFLOW_WS_METHODS.intakeTickets,
      concurrency: serialPerEnv,
    }),
    dryRunBoard: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:dry-run-board",
      tag: WORKFLOW_WS_METHODS.dryRunBoard,
      concurrency: serialPerEnv,
    }),
    proposeBoardImprovement: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:propose-board-improvement",
      tag: WORKFLOW_WS_METHODS.proposeBoardImprovement,
      concurrency: serialPerEnv,
    }),
    resolveBoardProposal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:resolve-board-proposal",
      tag: WORKFLOW_WS_METHODS.resolveBoardProposal,
      concurrency: serialPerEnv,
    }),
    revertBoardProposal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:revert-board-proposal",
      tag: WORKFLOW_WS_METHODS.revertBoardProposal,
      concurrency: serialPerEnv,
    }),
    createWorkSourceConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:create-work-source-connection",
      tag: WORKFLOW_WS_METHODS.createWorkSourceConnection,
      concurrency: serialPerEnv,
    }),
    deleteWorkSourceConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:delete-work-source-connection",
      tag: WORKFLOW_WS_METHODS.deleteWorkSourceConnection,
      concurrency: serialPerEnv,
    }),
    createOutboundConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:create-outbound-connection",
      tag: WORKFLOW_WS_METHODS.createOutboundConnection,
      concurrency: serialPerEnv,
    }),
    deleteOutboundConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:delete-outbound-connection",
      tag: WORKFLOW_WS_METHODS.deleteOutboundConnection,
      concurrency: serialPerEnv,
    }),
    importWorkItems: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:import-work-items",
      tag: WORKFLOW_WS_METHODS.importWorkItems,
      concurrency: serialPerEnv,
    }),
  };
}
