import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ProjectId,
  type WorktreeLayoutCommand,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "./i18n/messages";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { filesystemEnvironment } from "./state/filesystem";
import { environmentPresentations } from "./state/presentation";
import { readEnvironmentScope } from "./state/session";

export interface WorktreeLayoutApprovalRequest {
  /** Names this request, so an answer reaches only the request whose commands were on screen. */
  readonly id: number;
  readonly projectTitle: string;
  /** The commands that need approval, with the exact text that will be approved. */
  readonly commands: ReadonlyArray<WorktreeLayoutCommand>;
}

/** `open` goes false on an answer while `request` stays, so the closing dialog keeps its text. */
export interface WorktreeLayoutApprovalState {
  readonly request: WorktreeLayoutApprovalRequest | null;
  readonly open: boolean;
}

let state: WorktreeLayoutApprovalState = { request: null, open: false };
let resolvePending: ((approved: boolean) => void) | null = null;
let lastRequestId = 0;
const listeners = new Set<() => void>();

function publish(next: WorktreeLayoutApprovalState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function readWorktreeLayoutApprovalState(): WorktreeLayoutApprovalState {
  return state;
}

/** Only the dialog host subscribes; when it unmounts, an open question resolves as declined. */
export function subscribeWorktreeLayoutApprovalHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    if (state.request !== null) respondToWorktreeLayoutApproval(state.request.id, false);
  };
}

/** Answers the request `requestId` names. An answer to one that was since replaced is dropped. */
export function respondToWorktreeLayoutApproval(requestId: number, approved: boolean): void {
  if (state.request?.id !== requestId) return;
  const resolve = resolvePending;
  resolvePending = null;
  if (state.open) publish({ ...state, open: false });
  resolve?.(approved);
}

function requestWorktreeLayoutApproval(
  input: Omit<WorktreeLayoutApprovalRequest, "id">,
): Promise<boolean> {
  // No host to show the commands means nobody saw them.
  if (listeners.size === 0) return Promise.resolve(false);
  resolvePending?.(false);
  const request = { ...input, id: ++lastRequestId };
  return new Promise((resolve) => {
    resolvePending = resolve;
    publish({ request, open: true });
  });
}

export type WorktreeLayoutApprovalOutcome =
  /** Nothing is left to ask here; the server decides. */
  | { readonly status: "proceed" }
  | { readonly status: "cancelled" }
  | { readonly status: "blocked"; readonly message: string };

/**
 * Before a worktree thread starts: when the project's layout commands are not approved as
 * written, shows them and records the user's approval. The server refuses unapproved commands
 * either way, so a read that fails here lets the send go on to that answer.
 */
export async function ensureWorktreeLayoutApproved(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
}): Promise<WorktreeLayoutApprovalOutcome> {
  const { environmentId, projectId } = input;
  if (!readEnvironmentScope(environmentId, AuthFilesystemReadScope)) return { status: "proceed" };
  const read = await runAtomCommand(
    appAtomRegistry,
    filesystemEnvironment.readLayoutCommands,
    { environmentId, input: { projectId } },
    { reportFailure: false, reportDefect: false },
  );
  if (read._tag !== "Success") return { status: "proceed" };
  const commands = read.value.commands.filter((command) => !command.approved);
  if (commands.length === 0) return { status: "proceed" };
  // An approval would change nothing; the server's refusal names the policy.
  const policy = appAtomRegistry
    .get(environmentPresentations.serverConfigsAtom)
    .get(environmentId)?.managedPolicy;
  if (managedCapabilityDenial(policy, "worktreeLayoutCommands", m) !== undefined)
    return { status: "proceed" };
  if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
    return {
      status: "blocked",
      message: m(
        msg(
          "This project sets up worktrees with its own command, which nobody has approved as it is written now. This connection cannot approve it: approve it from a client that can use the terminal.",
        ),
      ),
    };
  }
  if (!(await requestWorktreeLayoutApproval({ projectTitle: input.projectTitle, commands }))) {
    return { status: "cancelled" };
  }
  const approved = await runAtomCommand(
    appAtomRegistry,
    filesystemEnvironment.approveLayoutCommands,
    {
      environmentId,
      input: {
        projectId,
        approvals: commands.map(({ kind, command }) => ({ kind, command })),
      },
    },
    { reportFailure: false },
  );
  if (approved._tag !== "Success") {
    const error = squashAtomCommandFailure(approved);
    return {
      status: "blocked",
      message:
        error instanceof Error
          ? error.message
          : m(msg("Could not approve the worktree layout command.")),
    };
  }
  return { status: "proceed" };
}
