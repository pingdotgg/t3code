import { useClerk } from "@clerk/react";
import {
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
import { useEffect, type ReactNode } from "react";

import { trackMountedClerk } from "../components/clerk/clerkLoadFailure";
import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

export function deactivateManagedRelayAuthentication(): void {
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateManagedRelayAuthentication(
  accountId: string,
  readClerkToken: () => Promise<string | null>,
): void {
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken,
  });
}

type ClerkInstance = ReturnType<typeof useClerk>;

function clerkTokenReader(clerk: ClerkInstance): () => Promise<string | null> {
  return async () =>
    clerk.session ? await clerk.session.getToken(resolveRelayClerkTokenOptions()) : null;
}

// A failed route removal fails the switch, so the next account never activates over the old routes.
async function cleanUpManagedRelayAccount(): Promise<void> {
  const [removal, tokenReset] = await Promise.all([
    runAtomCommand(appAtomRegistry, environmentCatalog.removeRelayEnvironments, undefined, {
      reportFailure: false,
      reportDefect: false,
    }),
    settleAsyncResult(() =>
      runtime.runPromiseExit(
        ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
      ),
    ),
  ]);
  reportAtomCommandResult(tokenReset, { label: "cloud account cleanup" });
  if (removal._tag !== "Success") throw squashAtomCommandFailure(removal);
}

const managedRelayAccountService = createCloudAccountService<ClerkInstance>({
  deactivate: deactivateManagedRelayAuthentication,
  detach: deactivateManagedRelayAuthentication,
  cleanUp: cleanUpManagedRelayAccount,
  activate: ({ source, accountId }) =>
    activateManagedRelayAuthentication(accountId, clerkTokenReader(source)),
});

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  // ClerkProvider creates the Clerk instance and owns its lifetime, so the
  // account service observes it for as long as this provider is mounted.
  const clerk = useClerk();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches the Clerk instance to the managed relay account service for the provider's lifetime
  useEffect(() => managedRelayAccountService.attach(clerk), [clerk]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- exposes the mounted Clerk instance's load status for the provider's lifetime
  useEffect(() => trackMountedClerk(clerk), [clerk]);
  return children;
}
