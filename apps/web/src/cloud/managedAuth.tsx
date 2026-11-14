import { useClerk } from "@clerk/react";
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
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, type ReactNode } from "react";

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

/** Shared by every sign-in provider: only how a source yields its relay token differs. */
export function createManagedRelayAccountService<S extends CloudAccountSource>(
  readToken: (source: S) => () => Promise<string | null>,
) {
  return createCloudAccountService<S>({
    deactivate: deactivateManagedRelayAuthentication,
    detach: deactivateManagedRelayAuthentication,
    cleanUp: async () => {
      const results = await Promise.all([
        runAtomCommand(appAtomRegistry, environmentCatalog.removeRelayEnvironments, undefined, {
          reportFailure: false,
          reportDefect: false,
        }),
        settleAsyncResult(() =>
          runtime.runPromiseExit(
            ManagedRelay.ManagedRelayClient.pipe(
              Effect.flatMap((client) => client.resetTokenCache),
            ),
          ),
        ),
      ]);
      for (const result of results) {
        reportAtomCommandResult(result, { label: "cloud account cleanup" });
      }
    },
    activate: ({ source, accountId }) =>
      activateManagedRelayAuthentication(accountId, readToken(source)),
  });
}

const managedRelayAccountService =
  createManagedRelayAccountService<ClerkInstance>(clerkTokenReader);

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  // ClerkProvider creates the Clerk instance and owns its lifetime, so the
  // account service observes it for as long as this provider is mounted.
  const clerk = useClerk();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches the Clerk instance to the managed relay account service for the provider's lifetime
  useEffect(() => managedRelayAccountService.attach(clerk), [clerk]);
  return children;
}
