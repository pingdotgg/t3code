import { useClerk, useSession, useSessionList } from "@clerk/react";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef } from "react";

import { unlinkPrimaryEnvironment } from "../../cloud/linkEnvironmentAtoms";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { isLoopbackHostname, readPrimaryEnvironmentTarget } from "../../environments/primary";
import { isHostedStaticApp } from "../../hostedPairing";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

export function useT3ConnectSignOut() {
  const clerk = useClerk();
  const { session } = useSession();
  const { sessions } = useSessionList();
  const eligibleSessions =
    sessions?.filter((session) => session.status === "active" || session.status === "pending") ??
    [];
  const link = usePrimaryCloudLinkState();
  const unlink = useAtomCommand(unlinkPrimaryEnvironment, { reportFailure: false });
  const pending = useRef(false);

  const signOut = async (allSessions: boolean) => {
    if (pending.current) return;
    pending.current = true;
    const result = await settlePromise(async () => {
      const primary = readPrimaryEnvironmentTarget();
      const isLocalHost =
        !isHostedStaticApp() &&
        primary !== null &&
        (primary.source === "desktop-managed" ||
          isLoopbackHostname(new URL(primary.target.httpBaseUrl).hostname));
      if (isLocalHost && link.target !== null) {
        const removedSessions = allSessions ? eligibleSessions : session ? [session] : [];
        for (const removedSession of removedSessions) {
          if (removedSession.user === null) continue;
          const token = await settlePromise(() =>
            removedSession.getToken(resolveRelayClerkTokenOptions()),
          );
          const unlinked = await unlink({
            target: link.target,
            clerkToken: token._tag === "Success" ? token.value : null,
            expectedCloudUserId: removedSession.user.id,
          });
          link.refresh();
          if (unlinked._tag === "Failure") {
            if (isAtomCommandInterrupted(unlinked)) return;
            throw squashAtomCommandFailure(unlinked);
          }
        }
      }
      await clerk.signOut(
        undefined,
        !allSessions && session ? { sessionId: session.id } : undefined,
      );
    });
    pending.current = false;
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not sign out of T3 Connect",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  };

  return {
    signOut: () => void signOut(false),
    signOutAll: () => void signOut(true),
    hasOtherSessions: eligibleSessions.length > 1,
  };
}
