/**
 * Thin compatibility shim for the Workflow Boards mobile screens.
 *
 * Provides `getEnvironmentClient` and `subscribeEnvironmentConnections` that
 * were previously exported from the deleted environment-session-registry module.
 * Implemented on top of the current connectionAtomRuntime + environmentSession atoms.
 */
import { WORKFLOW_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentRpcInput,
  EnvironmentRpcSuccess,
  EnvironmentUnaryRpcTag,
} from "@t3tools/client-runtime/rpc";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "./atom-registry";
import { environmentSession } from "./session";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function runRpc<TTag extends EnvironmentUnaryRpcTag>(
  environmentId: EnvironmentId,
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Promise<EnvironmentRpcSuccess<TTag>> {
  const cmd = createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: `mobile:board:${tag}`,
    tag,
  });
  const result = await runAtomCommand(
    appAtomRegistry,
    cmd,
    { environmentId, input },
    { reportFailure: false, reportDefect: false },
  );
  if (AsyncResult.isFailure(result)) {
    throw Cause.squash(result.cause);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Client object shape (the subset of EnvironmentApi.workflow used by WB screens)
// ---------------------------------------------------------------------------

interface WorkflowClient {
  readonly workflow: {
    listNeedsAttentionTickets: (
      input: EnvironmentRpcInput<typeof WORKFLOW_WS_METHODS.listNeedsAttentionTickets>,
    ) => Promise<EnvironmentRpcSuccess<typeof WORKFLOW_WS_METHODS.listNeedsAttentionTickets>>;
    getTicketDetail: (
      input: EnvironmentRpcInput<typeof WORKFLOW_WS_METHODS.getTicketDetail>,
    ) => Promise<EnvironmentRpcSuccess<typeof WORKFLOW_WS_METHODS.getTicketDetail>>;
    answerTicketStep: (
      input: EnvironmentRpcInput<typeof WORKFLOW_WS_METHODS.answerTicketStep>,
    ) => Promise<EnvironmentRpcSuccess<typeof WORKFLOW_WS_METHODS.answerTicketStep>>;
    resolveApproval: (
      input: EnvironmentRpcInput<typeof WORKFLOW_WS_METHODS.resolveApproval>,
    ) => Promise<EnvironmentRpcSuccess<typeof WORKFLOW_WS_METHODS.resolveApproval>>;
    moveTicket: (
      input: EnvironmentRpcInput<typeof WORKFLOW_WS_METHODS.moveTicket>,
    ) => Promise<EnvironmentRpcSuccess<typeof WORKFLOW_WS_METHODS.moveTicket>>;
    postTicketMessage: (
      input: EnvironmentRpcInput<typeof WORKFLOW_WS_METHODS.postTicketMessage>,
    ) => Promise<EnvironmentRpcSuccess<typeof WORKFLOW_WS_METHODS.postTicketMessage>>;
  };
}

function makeWorkflowClient(environmentId: EnvironmentId): WorkflowClient {
  return {
    workflow: {
      listNeedsAttentionTickets: (input) =>
        runRpc(environmentId, WORKFLOW_WS_METHODS.listNeedsAttentionTickets, input),
      getTicketDetail: (input) =>
        runRpc(environmentId, WORKFLOW_WS_METHODS.getTicketDetail, input),
      answerTicketStep: (input) =>
        runRpc(environmentId, WORKFLOW_WS_METHODS.answerTicketStep, input),
      resolveApproval: (input) =>
        runRpc(environmentId, WORKFLOW_WS_METHODS.resolveApproval, input),
      moveTicket: (input) => runRpc(environmentId, WORKFLOW_WS_METHODS.moveTicket, input),
      postTicketMessage: (input) =>
        runRpc(environmentId, WORKFLOW_WS_METHODS.postTicketMessage, input),
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a workflow client for the given environment if it currently has an
 * active prepared connection, or null otherwise.
 *
 * Designed to be called inside a `useSyncExternalStore` snapshot function:
 * the caller should re-subscribe via `subscribeEnvironmentConnections` to
 * receive a new snapshot whenever connection state changes.
 */
export function getEnvironmentClient(environmentId: EnvironmentId): WorkflowClient | null {
  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  return prepared !== null ? makeWorkflowClient(environmentId) : null;
}

/**
 * Subscribes to global environment connection changes (catalog additions,
 * removals, and connection establishment). Returns an unsubscribe function.
 *
 * Used with `useSyncExternalStore` to trigger a re-read of `getEnvironmentClient`
 * whenever any environment's connection state may have changed.
 */
export function subscribeEnvironmentConnections(onStoreChange: () => void): () => void {
  return appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, onStoreChange);
}
