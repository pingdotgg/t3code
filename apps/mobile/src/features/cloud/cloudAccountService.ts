import type { getClerkInstance } from "@clerk/expo";
import {
  type CloudAccountSource,
  createCloudAccountService,
  ManagedRelay,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  getComposerCloudAccountId,
  restoreCloudComposerDrafts,
} from "../../state/use-composer-drafts";
import {
  releaseAgentAwarenessRelayTokenProvider,
  setAgentAwarenessRelayTokenProvider,
  unregisterAgentAwarenessDeviceForCurrentUser,
} from "../agent-awareness/remoteRegistration";
import { removeCloudEnvironments } from "./cloud-drafts";
import { clearConnectOnboardingRequest, requestConnectOnboarding } from "./connectOnboarding";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

type ClerkInstance = ReturnType<typeof getClerkInstance>;

export function deactivateCloudRelayAccount(): void {
  setAgentAwarenessRelayTokenProvider(null);
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateCloudRelayAccount(
  accountId: string,
  tokenProvider: () => Promise<string | null>,
): void {
  setAgentAwarenessRelayTokenProvider(tokenProvider, accountId);
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken: tokenProvider,
  });
}

function clerkTokenReader(clerk: ClerkInstance): () => Promise<string | null> {
  return async () =>
    clerk.session ? await clerk.session.getToken(resolveRelayClerkTokenOptions()) : null;
}

const cleanUpCloudAccount = async <S>(
  readToken: (source: S) => () => Promise<string | null>,
  source: S,
  accountId: string | null,
  wasActive: boolean,
) => {
  const removal = await runAtomCommand(appAtomRegistry, removeCloudEnvironments, accountId, {
    reportFailure: false,
    reportDefect: false,
  });
  if (removal._tag !== "Success") throw squashAtomCommandFailure(removal);
  const results = await Promise.all([
    settleAsyncResult(() =>
      runtime.runPromiseExit(
        ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
      ),
    ),
    ...(wasActive
      ? [
          settleAsyncResult(() =>
            runtime.runPromiseExit(unregisterAgentAwarenessDeviceForCurrentUser(readToken(source))),
          ),
        ]
      : []),
  ]);
  for (const result of results) {
    reportAtomCommandResult(result, { label: "cloud account cleanup" });
  }
};

/** Shared by every sign-in provider: only how a source yields its relay token differs. */
export function createCloudRelayAccountService<S extends CloudAccountSource>(
  readToken: (source: S) => () => Promise<string | null>,
) {
  return createCloudAccountService<S>({
    deactivate: deactivateCloudRelayAccount,
    // Detaching is not a sign-out: the user is usually still signed in, so keep
    // lock-screen activities and the persisted registration for the next attach.
    detach: () => {
      releaseAgentAwarenessRelayTokenProvider();
      setManagedRelaySession(appAtomRegistry, null);
    },
    // A not-yet-presented onboarding request belongs to the account that left.
    onSignOutTransition: clearConnectOnboardingRequest,
    cleanUp: ({ source, accountId, wasActive }) =>
      cleanUpCloudAccount(readToken, source, accountId, wasActive),
    prepare: async ({ source, accountId, isCurrent }) => {
      const storedAccount = await getComposerCloudAccountId();
      if (storedAccount !== null && storedAccount !== accountId) {
        await cleanUpCloudAccount(readToken, source, storedAccount, false);
      }
      if (!isCurrent()) return;
      await restoreCloudComposerDrafts(accountId);
    },
    activate: ({ source, accountId, isAccountTransition }) => {
      activateCloudRelayAccount(accountId, readToken(source));
      // Issued after cleanup so the sheet never lists the previous account's environments.
      if (isAccountTransition) requestConnectOnboarding(accountId);
    },
  });
}

export const cloudAccountService = createCloudRelayAccountService<ClerkInstance>(clerkTokenReader);
