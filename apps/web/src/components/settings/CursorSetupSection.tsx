import { useRef, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

interface CursorSetupSectionProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
  readonly enabled: boolean;
}

export function CursorSetupSection(props: CursorSetupSectionProps) {
  if (props.readOnly) return null;
  if (!props.provider?.setup) {
    return (
      <SettingsRow
        title="Cursor account"
        description="Update this environment to sign in with Cursor."
      />
    );
  }
  if (!props.provider.setup.canAuthenticate) {
    return (
      <SettingsRow
        title="Cursor account"
        description="Using CURSOR_API_KEY. Remove it from this provider's environment to use browser sign-in."
      />
    );
  }
  return (
    <CursorSignIn
      key={`${props.environmentId}:${props.instanceId}`}
      {...props}
      provider={props.provider}
    />
  );
}

function CursorSignIn({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  enabled,
}: CursorSetupSectionProps & { readonly provider: ServerProvider }) {
  const target = { environmentId, input: { instanceId } };
  const query = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const auth = query.data;
  const commandOptions = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, commandOptions);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, commandOptions);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, commandOptions);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedFlow, setCopiedFlow] = useState<string | null>(null);
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const authenticated = provider.auth.status === "authenticated";
  const authorizationUrl = auth?.phase === "waiting" ? auth.authorizationUrl : null;
  const disabled = pending || auth === null || query.error !== null;
  const statusMessage =
    active || auth?.phase === "failed" || auth?.phase === "cancelled"
      ? auth.message
      : authenticated
        ? null
        : !enabled
          ? "Enable Cursor to sign in."
          : "Not signed in.";

  async function run<A, E>(request: () => Promise<AtomCommandResult<A, E>>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await request();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Cursor setup failed. Try again.");
      }
    } catch {
      setError("Cursor setup failed. Try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function openSignInPage() {
    if (!authorizationUrl) return;
    try {
      await ensureLocalApi().shell.openExternal(authorizationUrl);
      setError(null);
    } catch {
      setError("Could not open the sign-in page. Copy the link and open it in your browser.");
    }
  }

  async function copySignInLink() {
    if (!authorizationUrl) return;
    try {
      await writeTextToClipboard(authorizationUrl, "Cursor sign-in link");
      setCopiedFlow(auth?.flowId ?? null);
      setError(null);
    } catch {
      setError("Could not copy the sign-in link. Use Open sign-in page.");
    }
  }

  async function signOut() {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Sign out of Cursor for ${provider.displayName ?? "Cursor"} on ${environmentLabel}? This stops its running threads. Thread history is kept.`,
    );
    if (confirmed) await run(() => logout(target));
  }

  return (
    <SettingsRow
      title="Cursor account"
      description={statusMessage ? <span role="status">{statusMessage}</span> : null}
      control={
        <div className="flex min-w-0 flex-col gap-2 sm:max-w-72 sm:items-end sm:text-right">
          <div className="flex flex-wrap gap-2 sm:justify-end">
            {authorizationUrl ? (
              <>
                <Button size="sm" variant="outline" onClick={() => void openSignInPage()}>
                  Open sign-in page
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void copySignInLink()}>
                  {copiedFlow === auth?.flowId ? "Link copied" : "Copy link"}
                </Button>
              </>
            ) : null}
            {active && auth.flowId ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  const flowId = auth.flowId;
                  if (flowId)
                    void run(() => cancel({ environmentId, input: { instanceId, flowId } }));
                }}
              >
                Cancel
              </Button>
            ) : !active ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || !enabled}
                onClick={() => void run(() => start(target))}
              >
                {authenticated ? "Switch account" : "Sign in"}
              </Button>
            ) : null}
            {!active && authenticated && provider.auth.canLogout ? (
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void signOut()}>
                Sign out
              </Button>
            ) : null}
          </div>
          {error || query.error ? (
            <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
              {error ?? query.error}
            </p>
          ) : null}
          {query.error ? (
            <Button size="sm" variant="outline" onClick={() => query.refresh()}>
              Retry sign-in status
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
