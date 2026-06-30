import { RegistryContext } from "@effect/atom-react";
import {
  type AtomCommand,
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BoardId, BoardStreamItem, EnvironmentApi, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { useContext, useMemo } from "react";

import { workflowEnvironment } from "../state/workflow";

type WorkflowApi = EnvironmentApi["workflow"];

/**
 * Bridge that exposes the deleted `readEnvironmentApi(env).workflow.*` facade
 * shape on top of the new @effect/atom command layer, so the prop-drilled board
 * component tree (which takes `api: EnvironmentApi`) and `boardRpc.ts` keep
 * working unchanged. Each method runs the matching imperative atom command and
 * resolves/rejects a Promise (throwing the squashed failure to preserve the old
 * facade's reject-on-error contract).
 *
 * NOTE: live board STATE is NOT consumed through this facade's `subscribeBoard`
 * — the board route reads `workflowEnvironment.board(...)` (the folded
 * subscription atom) directly. `subscribeBoard` here is a best-effort bridge for
 * facade completeness over the raw stream atom.
 */
export function useWorkflowApi(environmentId: EnvironmentId): WorkflowApi {
  const registry = useContext(RegistryContext);

  return useMemo<WorkflowApi>(() => {
    // Each command is keyed `{ environmentId, input }`; resolve the AtomCommand
    // result into a Promise, throwing the squashed cause on failure.
    const run = <A, E, I>(
      command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
      input: I,
    ): Promise<A> =>
      runAtomCommand(registry, command, { environmentId, input }, { reportFailure: false }).then(
        (result) => {
          if (AsyncResult.isSuccess(result)) {
            return result.value;
          }
          throw squashAtomCommandFailure(result);
        },
      );

    // Reads are QUERY atom families (not commands) — mount + read the atom via
    // executeAtomQuery rather than runAtomCommand (a family has no `.run`).
    const readQuery = <A, E, I>(
      family: (target: {
        readonly environmentId: EnvironmentId;
        readonly input: I;
      }) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
      input: I,
    ): Promise<A> =>
      executeAtomQuery(registry, family({ environmentId, input }), { reportFailure: false }).then(
        (result) => {
          if (AsyncResult.isSuccess(result)) {
            return result.value;
          }
          throw squashAtomCommandFailure(result);
        },
      );

    const w = workflowEnvironment;

    return {
      listBoards: (input) => readQuery(w.listBoards, input),
      createBoard: (input) => run(w.createBoard, input),
      importBoard: (input) => run(w.importBoard, input),
      createWorkflowBoard: (input) => run(w.createWorkflowBoard, input),
      generateWorkflowDraft: (input) => run(w.generateWorkflowDraft, input),
      listBoardTemplates: (input) => readQuery(w.listBoardTemplates, input),
      deleteBoard: (input) => run(w.deleteBoard, input),
      renameBoard: (input) => run(w.renameBoard, input),
      getBoard: (input) => readQuery(w.getBoard, input),
      getBoardDefinition: (input) => readQuery(w.getBoardDefinition, input),
      saveBoardDefinition: (input) => run(w.saveBoardDefinition, input),
      listBoardVersions: (input) => readQuery(w.listBoardVersions, input),
      getBoardVersion: (input) => readQuery(w.getBoardVersion, input),
      subscribeBoard: (input, callback, options) =>
        subscribeBoardRaw(registry, environmentId, input, callback, options),
      createTicket: (input) => run(w.createTicket, input),
      editTicket: (input) => run(w.editTicket, input),
      moveTicket: (input) => run(w.moveTicket, input),
      runLane: (input) => run(w.runLane, input),
      resolveApproval: (input) => run(w.resolveApproval, input),
      answerTicketStep: (input) => run(w.answerTicketStep, input),
      postTicketMessage: (input) => run(w.postTicketMessage, input),
      editTicketMessage: (input) => run(w.editTicketMessage, input),
      setProjectScriptTrust: (input) => run(w.setProjectScriptTrust, input),
      cancelStep: (input) => run(w.cancelStep, input),
      getTicketDetail: (input) => readQuery(w.getTicketDetail, input),
      getTicketDiff: (input) => readQuery(w.getTicketDiff, input),
      intakeTickets: (input) => run(w.intakeTickets, input),
      listTicketArtifacts: (input) => readQuery(w.listTicketArtifacts, input),
      getWebhookConfig: (input) => readQuery(w.getWebhookConfig, input),
      getBoardDigest: (input) => readQuery(w.getBoardDigest, input),
      getBoardMetrics: (input) => readQuery(w.getBoardMetrics, input),
      dryRunBoard: (input) => run(w.dryRunBoard, input),
      listWorkSourceConnections: (input) => readQuery(w.listWorkSourceConnections, input),
      createWorkSourceConnection: (input) => run(w.createWorkSourceConnection, input),
      deleteWorkSourceConnection: (input) => run(w.deleteWorkSourceConnection, input),
      listOutboundConnections: (input) => readQuery(w.listOutboundConnections, input),
      createOutboundConnection: (input) => run(w.createOutboundConnection, input),
      deleteOutboundConnection: (input) => run(w.deleteOutboundConnection, input),
      proposeBoardImprovement: (input) => run(w.proposeBoardImprovement, input),
      listBoardProposals: (input) => readQuery(w.listBoardProposals, input),
      getBoardProposal: (input) => readQuery(w.getBoardProposal, input),
      resolveBoardProposal: (input) => run(w.resolveBoardProposal, input),
      revertBoardProposal: (input) => run(w.revertBoardProposal, input),
      listImportableWorkItems: (input) => readQuery(w.listImportableWorkItems, input),
      importWorkItems: (input) => run(w.importWorkItems, input),
    } satisfies WorkflowApi;
  }, [registry, environmentId]);
}

/**
 * Best-effort raw board subscription for the facade's `subscribeBoard`. Mounts
 * the raw (untransformed) board stream atom and forwards each emitted
 * BoardStreamItem to the callback. The board route reads folded state from
 * `workflowEnvironment.board(...)` directly and does not depend on this.
 */
function subscribeBoardRaw(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  input: { readonly boardId: BoardId },
  callback: (event: BoardStreamItem) => void,
  _options?: { onResubscribe?: () => void },
): () => void {
  const atom = workflowEnvironment.boardRaw({ environmentId, input });
  const unmount = registry.mount(atom);
  const unsubscribe = registry.subscribe(atom, (result) => {
    if (AsyncResult.isSuccess(result)) {
      callback(result.value);
    }
  });
  return () => {
    unsubscribe();
    unmount();
  };
}
