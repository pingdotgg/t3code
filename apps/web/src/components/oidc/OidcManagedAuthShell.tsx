import type { OidcController } from "@t3tools/client-runtime/relay";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";

import { CloudAuthProvider, type CloudAuth } from "../../cloud/cloudAuth";
import { createManagedRelayAccountService } from "../../cloud/managedAuth";
import {
  getBrowserOidcController,
  signInThroughDesktopBrowser,
} from "../../cloud/oidc/browserOidc";
import { toastManager } from "../ui/toast";

// The relay verifies the ID token, so that is what the controller hands out as the relay token.
const accountService = createManagedRelayAccountService<OidcController>(
  (controller) => controller.getToken,
);

function reportSignInFailure(cause: unknown) {
  toastManager.add({
    type: "error",
    title: "Could not start sign-in",
    description: cause instanceof Error ? cause.message : "The identity provider did not respond.",
  });
}

function ConfiguredOidcShell({
  controller,
  children,
}: {
  readonly controller: OidcController;
  readonly children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches the OIDC controller to the managed relay account service for the provider's lifetime
  useEffect(() => accountService.attach(controller), [controller]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- another tab signs in, refreshes, or signs out through shared storage
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === controller.storageKey) controller.syncFromStorage();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [controller]);

  const value: CloudAuth = {
    provider: "oidc",
    isLoaded: true,
    isSignedIn: snapshot.userId !== null,
    hasSession: snapshot.userId !== null,
    userId: snapshot.userId,
    accountLabel: snapshot.label,
    getToken: controller.getToken,
    signIn: () => {
      const signedIn =
        signInThroughDesktopBrowser(controller) ??
        controller.signIn(`${window.location.pathname}${window.location.search}`);
      void signedIn.catch(reportSignInFailure);
    },
    signOut: controller.signOut,
    openAccount: null,
  };

  return <CloudAuthProvider value={value}>{children}</CloudAuthProvider>;
}

/** Lazy-loaded when the build configures an OpenID Connect provider; Clerk is not loaded then. */
export default function OidcManagedAuthShell({ children }: { readonly children: ReactNode }) {
  const controller = getBrowserOidcController();
  return controller === null ? (
    children
  ) : (
    <ConfiguredOidcShell controller={controller}>{children}</ConfiguredOidcShell>
  );
}
