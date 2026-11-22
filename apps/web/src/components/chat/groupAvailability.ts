import { msg } from "gt-react";
import { m } from "../../i18n/messages";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { orchestrationEnvironment } from "~/state/orchestration";
import { environmentPresentations } from "~/state/presentation";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Whether this environment offers Invite: the user may invite there and Group conversations is on
 * (Settings > Labs). The server refuses invites while it is off; End, Remove and Stop never wait on it.
 */
export const canInviteToGroupAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(orchestrationEnvironment.inviteToGroup.permissionAtom(environmentId)) &&
      get(environmentPresentations.serverConfigsAtom).get(environmentId)?.settings
        .groupConversationsEnabled === true,
  ).pipe(Atom.withLabel(`group:invite-available:${environmentId}`)),
);

export function useCanInviteToGroup(environmentId: EnvironmentId): boolean {
  return useAtomValue(canInviteToGroupAtom(environmentId));
}

/**
 * The thread whose model picker is open to invite someone. The `/invite` command, the composer and
 * the command palette all ask here, and the thread's composer renders the one picker.
 */
export const groupInviteRequestAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("group:invite-request"),
);

export function requestGroupInvite(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(groupInviteRequestAtom, threadRef);
}

/** A refusal says what the user can do about it, so it is shown rather than only logged. */
export function reportGroupCommandFailure(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
) {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : m(msg("An error occurred.")),
    }),
  );
}
