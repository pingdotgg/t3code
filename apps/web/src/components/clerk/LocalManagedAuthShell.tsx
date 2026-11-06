import { T3ChatUserProfilePage } from "./T3ChatUserProfilePage";
import { Clerk } from "@clerk/clerk-js";
import { useAuth, useClerk } from "@clerk/react";
import { InternalClerkProvider } from "@clerk/react/internal";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";
import { useState, type ReactNode, type ComponentProps } from "react";
import { AuthRelayWriteScope } from "@t3tools/contracts";

import { ConnectAuthProvider } from "../../cloud/connectAuth";
import {
  ManagedRelayAuthProvider,
  deactivateManagedRelayAuthentication,
} from "../../cloud/managedAuth";
import { resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { createNativeClerkTransport } from "./nativeClerkTransport";
import { T3ConnectUserProfilePage } from "./T3ConnectUserProfilePage";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

const clients = new Map<string, Clerk>();

function nativeClient(publishableKey: string, environmentId: string) {
  const key = `${environmentId}:${publishableKey}`;
  const cached = clients.get(key);
  if (cached) return cached;
  const clerk = new Clerk(publishableKey);
  const transport = createNativeClerkTransport({
    frontendApi: clerkFrontendApiUrlFromPublishableKey(publishableKey),
    origin: window.location.origin,
    storage: window.localStorage,
    storageKey: `t3-connect-native-client:${key}`,
  });
  clerk.__internal_onBeforeRequest(transport.beforeRequest);
  clerk.__internal_onAfterResponse(transport.afterResponse);
  clients.set(key, clerk);
  return clerk;
}

export default function LocalManagedAuthShell(props: {
  readonly children: ReactNode;
  readonly publishableKey: string;
}) {
  return (
    <AppAtomRegistryProvider>
      <NativeAuthGate {...props} />
    </AppAtomRegistryProvider>
  );
}

function NativeAuthGate({
  children,
  publishableKey,
}: {
  readonly children: ReactNode;
  readonly publishableKey: string;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const authorized = useEnvironmentScope(environmentId, AuthRelayWriteScope);
  // Pairing must finish before the SDK contacts the authenticated proxy.
  const client = environmentId && authorized ? nativeClient(publishableKey, environmentId) : null;
  if (!client) return <>{children}</>;
  return (
    <InternalClerkProvider
      // Clerk JS and React disagree on an optional internal timeout under exactOptionalPropertyTypes.
      Clerk={client as NonNullable<ComponentProps<typeof InternalClerkProvider>["Clerk"]>}
      publishableKey={publishableKey}
      standardBrowser={false}
    >
      <NativeAccount>
        <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
      </NativeAccount>
    </InternalClerkProvider>
  );
}

function NativeAccount({ children }: { readonly children: ReactNode }) {
  const {
    isLoaded,
    isSignedIn,
    userId,
    getToken: getClerkToken,
  } = useAuth({ treatPendingAsSignedOut: false });
  const clerk = useClerk();
  const getToken = () => getClerkToken(resolveRelayClerkTokenOptions());
  const [signInOpen, setSignInOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountPage, setAccountPage] = useState<
    "mobile-clients" | "t3-connect" | "t3-chat" | null
  >(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- Clerk SDK client, not a T3 environment RPC client; the proxy enforces relay permission.
    const { client: clerkClient } = clerk;
    const signIn = clerkClient?.signIn;
    if (!signIn || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!sent) {
        const attempt = await signIn.create({ identifier: email.trim() });
        const factor = attempt.supportedFirstFactors?.find(
          (factor) => factor.strategy === "email_code",
        );
        if (!factor || factor.strategy !== "email_code")
          throw new Error("Email verification is not available for this account.");
        await signIn.prepareFirstFactor({
          strategy: "email_code",
          emailAddressId: factor.emailAddressId,
        });
        setSent(true);
      } else {
        const attempt = await signIn.attemptFirstFactor({
          strategy: "email_code",
          code: code.trim(),
        });
        if (attempt.status !== "complete" || !attempt.createdSessionId)
          throw new Error("Sign-in needs another verification step.");
        await clerk.setActive({ session: attempt.createdSessionId });
        setSignInOpen(false);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not sign in. Check your details and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    await clerk.signOut();
    deactivateManagedRelayAuthentication();
    setAccountOpen(false);
  };
  return (
    <ConnectAuthProvider
      value={{
        mode: "native",
        canSignIn: true,
        isLoaded,
        isSignedIn: !!isSignedIn,
        userId: userId ?? null,
        identity: clerk.user?.primaryEmailAddress?.emailAddress ?? null,
        getToken,
        signOut,
        openSignIn: () => {
          setSent(false);
          setCode("");
          setError(null);
          setSignInOpen(true);
        },
        openAccount: (page) => {
          setAccountPage(page ?? null);
          setAccountOpen(true);
        },
      }}
    >
      {children}
      <Dialog
        open={signInOpen}
        onOpenChange={(open) => {
          if (!busy) setSignInOpen(open);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Sign in to T3 Connect</DialogTitle>
            <DialogDescription>
              Use the email address on your existing T3 Connect account.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogPanel>
              {sent ? (
                <>
                  <p>Enter the verification code sent to {email}.</p>
                  <Input
                    aria-label="Verification code"
                    value={code}
                    onValueChange={setCode}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    disabled={busy}
                    required
                  />
                </>
              ) : (
                <Input
                  aria-label="Email address"
                  type="email"
                  value={email}
                  onValueChange={setEmail}
                  autoComplete="email"
                  disabled={busy}
                  required
                />
              )}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setSignInOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !isLoaded}>
                {busy ? "Signing in…" : sent ? "Verify code" : "Send code"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
      <Dialog open={accountOpen} onOpenChange={setAccountOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>T3 Connect account</DialogTitle>
            <DialogDescription>
              {clerk.user?.primaryEmailAddress?.emailAddress ?? "Signed in to T3 Connect"}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {accountPage === null || accountPage === "t3-connect" ? (
              <T3ConnectUserProfilePage />
            ) : null}
            {accountPage === null || accountPage === "mobile-clients" ? (
              <MobileClientsUserProfilePage />
            ) : null}
            {accountPage === null || accountPage === "t3-chat" ? <T3ChatUserProfilePage /> : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => void signOut()}>
              Sign out
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </ConnectAuthProvider>
  );
}
