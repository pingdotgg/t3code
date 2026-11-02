import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderAuthRespondInput,
  ProviderAuthResponse,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { useAtomValue } from "@effect/atom-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { CopyIcon } from "lucide-react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";
import { RedactedSensitiveText } from "./RedactedSensitiveText";

const ProviderAuthTerminal = lazy(() => import("./ProviderAuthTerminal"));

export function ProviderAuthenticationSection({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  readOnly,
  autoOpenBrowser = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
  readonly autoOpenBrowser?: boolean;
}) {
  const target = { environmentId, input: { instanceId } };
  const query = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const commands = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, commands);
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, commands);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, commands);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, commands);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, commands);
  const canInstallCodex = provider.driver === "codex" && provider.setup?.canInstall === true;
  const installQuery = useEnvironmentQuery(
    canInstallCodex ? serverEnvironment.providerInstallState(target) : null,
  );
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, commands);
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, commands);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, commands);
  const canStartInstall = useAtomValue(
    serverEnvironment.startProviderInstall.permissionAtom(environmentId),
  );
  const canCancelInstall = useAtomValue(
    serverEnvironment.cancelProviderInstall.permissionAtom(environmentId),
  );
  const [methodId, setMethodId] = useState("");
  const [draft, setDraft] = useState({ id: "", values: {} as Record<string, string> });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const reservedBrowser = useRef<Window | null>(null);
  const [browserFlowId, setBrowserFlowId] = useState<string | null>(null);
  const handledBrowserFlow = useRef<string | null>(null);
  const refreshedInstallation = useRef<string | null>(null);
  const installation = installQuery.data;
  const terminalQueue = useRef<ProviderAuthRespondInput[]>([]);
  const terminalSending = useRef(false);
  const auth = query.data;
  const interaction = auth?.interaction;
  const acceptsCode = interaction?.type === "browser" && interaction.callbackInputKind === "code";
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const installActive =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const updateAvailable =
    provider.installed &&
    provider.version != null &&
    installation?.version != null &&
    compareSemverVersions(installation.version, provider.version) > 0;
  const installationKey =
    installation?.phase === "succeeded" && installation.source === "managed"
      ? `${installation.operationId ?? ""}:${installation.installedVersion ?? ""}:${installation.executablePath ?? ""}`
      : null;
  const signedIn =
    provider.auth.status === "authenticated" ||
    (provider.auth.status === "unknown" && auth?.phase === "succeeded");
  const isDiscovering =
    provider.driver === "acpRegistry" &&
    !active &&
    !signedIn &&
    !query.error &&
    auth?.methods === undefined;
  const needsExternalSetup =
    !active &&
    !signedIn &&
    (provider.setup?.canAuthenticate === false ||
      (provider.driver === "acpRegistry" && auth?.methods?.length === 0));
  const usesCredentials =
    provider.driver === "antigravity" &&
    (provider.auth.type === "gemini-api-key" || provider.auth.type === "agent-platform");
  const accountDescription = active
    ? auth?.phase === "starting"
      ? (auth.message ?? (usesCredentials ? "Connecting…" : "Starting sign-in…"))
      : auth?.phase === "verifying"
        ? usesCredentials
          ? "Checking credentials and loading models…"
          : "Checking your account…"
        : interaction?.type === "terminal"
          ? "Complete sign-in in the terminal below."
          : interaction?.type === "credentials"
            ? "Enter your credentials below."
            : "Finish signing in in your browser."
    : signedIn
      ? "Signed in."
      : canInstallCodex && !provider.installed
        ? "Install Codex CLI on this environment before signing in."
        : isDiscovering
          ? "Discovering sign-in methods…"
          : needsExternalSetup
            ? "No in-app sign-in advertised. Follow the provider's docs to finish setup."
            : usesCredentials
              ? `Connect on ${environmentLabel} to load models.`
              : `Sign in on ${environmentLabel}.`;
  const statusMessage = auth?.phase === "failed" ? auth.message : null;
  const disabled = readOnly || pending || query.error !== null || isDiscovering;
  const installDisabled =
    readOnly || pending || !canStartInstall || installQuery.error !== null || installation === null;
  const cancelInstallDisabled =
    readOnly ||
    pending ||
    !canCancelInstall ||
    installQuery.error !== null ||
    installation === null;
  const draftId = `${auth?.flowId ?? ""}:${interaction?.id ?? ""}`;
  const values = draft.id === draftId ? draft.values : {};
  const url =
    interaction?.type === "browser" || interaction?.type === "deviceCode"
      ? interaction.url
      : auth?.authorizationUrl;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh the provider catalog when the external CLI installation completes.
  useEffect(() => {
    if (!canInstallCodex || installationKey === null) {
      refreshedInstallation.current = null;
      return;
    }
    if (refreshedInstallation.current === installationKey) return;
    refreshedInstallation.current = installationKey;
    void refreshProviders({ environmentId, input: { instanceId } });
  }, [canInstallCodex, environmentId, instanceId, installationKey, refreshProviders]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Close the reserved OAuth browser window when this surface unmounts.
  useEffect(() => () => reservedBrowser.current?.close(), []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Navigate or close the reserved browser as the external OAuth flow changes.
  useEffect(() => {
    if (!browserFlowId || handledBrowserFlow.current === browserFlowId) return;
    if (query.error || (auth?.flowId === browserFlowId && !active)) {
      reservedBrowser.current?.close();
      reservedBrowser.current = null;
      handledBrowserFlow.current = browserFlowId;
      return;
    }
    if (auth?.flowId !== browserFlowId || !url || !interaction) return;
    if (
      interaction.type !== "deviceCode" &&
      (interaction.type !== "browser" || interaction.requiresConsent)
    )
      return;
    const tab = reservedBrowser.current;
    reservedBrowser.current = null;
    handledBrowserFlow.current = browserFlowId;
    if (tab && !tab.closed) {
      tab.location.href = url;
    } else {
      void ensureLocalApi()
        .shell.openExternal(url)
        .catch(() => {
          setError("Could not open the sign-in page. Use Open browser or copy the link.");
        });
    }
  }, [active, auth?.flowId, browserFlowId, interaction, query.error, url]);

  async function run<A, E>(
    command: () => Promise<AtomCommandResult<A, E>>,
    failureMessage = "Provider sign-in failed. Try again.",
  ) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    let succeeded = false;
    try {
      const result = await command();
      if (result._tag === "Success") succeeded = true;
      else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : failureMessage);
      }
    } catch {
      setError(failureMessage);
    }
    pendingRef.current = false;
    setPending(false);
    return succeeded;
  }

  async function beginSignIn() {
    if (pendingRef.current) return;
    if (autoOpenBrowser && !window.desktopBridge) {
      reservedBrowser.current = window.open("", "_blank");
      if (reservedBrowser.current) reservedBrowser.current.opener = null;
    }
    const succeeded = await run(async () => {
      const result = await start({
        environmentId,
        input: {
          instanceId,
          ...(methodId && auth?.methods?.some((method) => method.id === methodId)
            ? { methodId }
            : {}),
        },
      });
      if (autoOpenBrowser && result._tag === "Success") setBrowserFlowId(result.value.flowId);
      return result;
    });
    if (!succeeded) {
      reservedBrowser.current?.close();
      reservedBrowser.current = null;
    }
  }

  async function send(response: ProviderAuthResponse) {
    if (!auth?.flowId || !interaction) return false;
    return run(() =>
      respond({
        environmentId,
        input: { instanceId, flowId: auth.flowId!, interactionId: interaction.id, response },
      }),
    );
  }

  async function openBrowser() {
    if (!url || readOnly) return;
    const requiresConsent = interaction?.type === "browser" && interaction.requiresConsent;
    // Reserve tabs before awaiting consent; browsers block later opens.
    const pending = requiresConsent && !window.desktopBridge ? window.open("", "_blank") : null;
    if (pending) pending.opener = null;
    try {
      if (requiresConsent && !(await send({ type: "browser", action: "accept" }))) {
        pending?.close();
        return;
      }
      if (pending) pending.location.href = url;
      else await ensureLocalApi().shell.openExternal(url);
      setError(null);
    } catch {
      pending?.close();
      setError("Could not open the sign-in page. Copy the link and open it in your browser.");
    }
  }

  function updateDraft(name: string, value: string) {
    setDraft({ id: draftId, values: { ...values, [name]: value } });
  }

  const installStatus =
    installation?.phase === "downloading"
      ? `Downloading Codex CLI (${(installation.downloadedBytes / 1_000_000).toFixed(1)} MB${installation.totalBytes === null ? "" : ` of ${(installation.totalBytes / 1_000_000).toFixed(1)} MB`}).`
      : installation?.phase === "extracting"
        ? "Extracting Codex CLI."
        : installation?.phase === "verifying"
          ? "Checking Codex CLI."
          : installation?.phase === "succeeded" &&
              installation.source === "local" &&
              !provider.installed
            ? "This provider cannot use the environment's Codex executable. Install Codex CLI for this provider."
            : installation?.phase === "succeeded" && !provider.installed
              ? "Codex CLI is installed. Checking whether this provider can run it."
              : installation?.phase === "failed" || installation?.phase === "cancelled"
                ? (installation.message ?? "Codex CLI installation failed.")
                : updateAvailable
                  ? `Codex ${installation.version} is available.`
                  : null;

  return (
    <SettingsRow
      title="Account"
      description={
        signedIn && !active && provider.auth.email?.trim() ? (
          <span>
            Signed in as{" "}
            <RedactedSensitiveText
              key={provider.auth.email}
              value={provider.auth.email}
              ariaLabel="Toggle account email visibility"
              revealTooltip="Click to reveal email"
              hideTooltip="Click to hide email"
              className="max-w-full truncate"
            />
          </span>
        ) : (
          <span role="status">{accountDescription}</span>
        )
      }
      status={
        statusMessage ? (
          <p role="status" className="[overflow-wrap:anywhere]">
            {statusMessage}
          </p>
        ) : installQuery.error || (canInstallCodex && installStatus) ? (
          <div>
            <p
              role={installQuery.error ? "alert" : "status"}
              className={
                installQuery.error
                  ? "text-destructive [overflow-wrap:anywhere]"
                  : "text-muted-foreground [overflow-wrap:anywhere]"
              }
            >
              {installQuery.error ?? installStatus}
            </p>
            {installation?.phase === "downloading" &&
            installation.totalBytes !== null &&
            installation.totalBytes > 0 ? (
              <progress
                aria-label="Codex CLI download"
                className="mt-2 block h-1 w-full accent-foreground"
                value={installation.downloadedBytes}
                max={installation.totalBytes}
              />
            ) : null}
          </div>
        ) : undefined
      }
      control={
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {canInstallCodex && (!provider.installed || updateAvailable || installActive) ? (
            installActive ? (
              installation.operationId ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={cancelInstallDisabled}
                  onClick={() => {
                    const operationId = installation.operationId;
                    if (!operationId) return;
                    void run(
                      () => cancelInstall({ environmentId, input: { instanceId, operationId } }),
                      "Could not cancel Codex installation. Try again.",
                    );
                  }}
                >
                  Cancel installation
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled>
                  Installing Codex CLI
                </Button>
              )
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={installDisabled || active}
                onClick={() => {
                  if (!updateAvailable && installation?.phase === "succeeded") {
                    if (installation.source === "local") {
                      void run(
                        () => startInstall({ environmentId, input: { instanceId } }),
                        "Could not install Codex CLI. Try again.",
                      );
                    } else {
                      void run(
                        () => refreshProviders({ environmentId, input: { instanceId } }),
                        "Could not refresh Codex status. Try again.",
                      );
                    }
                  } else {
                    void run(
                      () => startInstall({ environmentId, input: { instanceId } }),
                      "Could not install Codex CLI. Try again.",
                    );
                  }
                }}
              >
                {updateAvailable
                  ? "Update Codex CLI"
                  : installation?.phase === "failed" || installation?.phase === "cancelled"
                    ? "Retry installation"
                    : installation?.phase === "succeeded"
                      ? installation.source === "local"
                        ? "Install Codex CLI"
                        : "Refresh status"
                      : "Install Codex CLI"}
              </Button>
            )
          ) : null}
          {!active && (auth?.methods?.length ?? 0) > 1 ? (
            <Select
              value={auth?.methods?.some((method) => method.id === methodId) ? methodId : ""}
              disabled={disabled}
              onValueChange={(value) => setMethodId(value ?? "")}
            >
              <SelectTrigger size="sm" aria-label="Sign-in method" className="w-44">
                <SelectValue>
                  {auth?.methods?.find((method) => method.id === methodId)?.name ??
                    "Provider default"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="">Provider default</SelectItem>
                {auth?.methods?.map((method) => (
                  <SelectItem key={method.id} value={method.id}>
                    {method.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          {url ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => void openBrowser()}
              >
                Open browser
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Copy sign-in link"
                      size="icon-sm"
                      variant="ghost-muted"
                      disabled={disabled}
                      onClick={() => {
                        // Copy during the click to retain clipboard activation; consent must still be
                        // recorded before use.
                        const copied = writeTextToClipboard(url, "Provider sign-in link");
                        void (async () => {
                          await copied;
                          if (interaction?.type === "browser" && interaction.requiresConsent)
                            await send({ type: "browser", action: "accept" });
                        })().catch(() => setError("Could not copy the sign-in link."));
                      }}
                    >
                      <CopyIcon />
                    </Button>
                  }
                />
                <TooltipPopup>Copy sign-in link</TooltipPopup>
              </Tooltip>
            </>
          ) : null}
          <>
            {needsExternalSetup && provider.setup?.documentationUrl ? (
              <Button
                size="sm"
                variant="outline"
                render={
                  <a href={provider.setup.documentationUrl} target="_blank" rel="noreferrer" />
                }
              >
                Open docs
              </Button>
            ) : active && auth?.flowId ? (
              <Button
                size="sm"
                variant="ghost-muted"
                aria-label="Cancel sign-in"
                disabled={disabled}
                onClick={() =>
                  void run(() =>
                    cancel({ environmentId, input: { instanceId, flowId: auth.flowId! } }),
                  )
                }
              >
                Cancel
              </Button>
            ) : !active && !needsExternalSetup && provider.setup?.canAuthenticate !== false ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || !provider.enabled || !provider.installed || !auth}
                onClick={() => void beginSignIn()}
              >
                {signedIn
                  ? "Change account"
                  : auth?.phase === "failed" || auth?.phase === "cancelled"
                    ? usesCredentials
                      ? "Retry connection"
                      : "Retry sign-in"
                    : usesCredentials
                      ? "Connect"
                      : "Sign in"}
              </Button>
            ) : null}
            {!active && signedIn && (provider.auth.canLogout ?? provider.setup?.canAuthenticate) ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || !auth}
                onClick={() => {
                  void ensureLocalApi()
                    .dialogs.confirm(
                      `Sign out of ${provider.displayName ?? provider.driver} on ${environmentLabel}? This stops running threads that share this sign-in. Thread history is kept.`,
                    )
                    .then((confirmed) => {
                      if (confirmed) void run(() => logout(target));
                    });
                }}
              >
                Sign out
              </Button>
            ) : null}
          </>
        </div>
      }
    >
      {interaction?.type === "terminal" ||
      interaction?.type === "credentials" ||
      interaction?.type === "deviceCode" ||
      (url && (interaction?.type === "browser" ? interaction.acceptsCallback : !interaction)) ||
      error ||
      query.error ? (
        <>
          {interaction?.type === "deviceCode" ? (
            <p className="py-2 text-sm text-muted-foreground">
              Enter code{" "}
              <code className="select-all font-mono text-foreground">{interaction.userCode}</code>{" "}
              in your browser.
            </p>
          ) : null}
          {interaction?.type === "terminal" ? (
            <div className="py-2">
              <Suspense
                fallback={
                  <p className="text-xs text-muted-foreground">Loading sign-in terminal…</p>
                }
              >
                <ProviderAuthTerminal
                  key={`${auth?.flowId}:${interaction.id}`}
                  output={interaction.output}
                  outputOffset={interaction.outputOffset}
                  onResponse={(response) => {
                    if (readOnly || !auth?.flowId) return;
                    for (
                      let offset = 0;
                      offset < Math.max(1, response.data.length);
                      offset += 4_096
                    ) {
                      terminalQueue.current.push({
                        instanceId,
                        flowId: auth.flowId,
                        interactionId: interaction.id,
                        response: {
                          ...response,
                          data: response.data.slice(offset, offset + 4_096),
                        },
                      });
                    }
                    if (terminalSending.current) return;
                    terminalSending.current = true;
                    void (async () => {
                      while (terminalQueue.current.length > 0) {
                        const input = terminalQueue.current.shift()!;
                        const result = await respond({ environmentId, input });
                        if (result._tag !== "Success") {
                          terminalQueue.current = [];
                          if (!isAtomCommandInterrupted(result))
                            setError("The provider sign-in terminal is no longer available.");
                          break;
                        }
                      }
                    })()
                      .catch(() => {
                        terminalQueue.current = [];
                        setError("Could not send input to the provider sign-in terminal.");
                      })
                      .finally(() => {
                        terminalSending.current = false;
                      });
                  }}
                />
              </Suspense>
            </div>
          ) : null}
          {interaction?.type === "credentials" ? (
            <form
              className="grid gap-2 py-2 text-sm leading-normal"
              onSubmit={(event) => {
                event.preventDefault();
                void send({ type: "credentials", values }).then((sent) => {
                  if (sent) setDraft({ id: "", values: {} });
                });
              }}
            >
              {interaction.fields.map((field) => (
                <label key={field.name} className="grid gap-1">
                  {field.label}
                  <Input
                    size="sm"
                    type={field.secret ? "password" : "text"}
                    autoComplete="off"
                    value={values[field.name] ?? ""}
                    disabled={disabled}
                    maxLength={16_384}
                    onChange={(event) => updateDraft(field.name, event.target.value)}
                  />
                </label>
              ))}
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="w-fit"
                disabled={disabled}
              >
                Connect
              </Button>
            </form>
          ) : null}
          {url && (interaction?.type === "browser" ? interaction.acceptsCallback : !interaction) ? (
            <form
              className="grid gap-2 py-2 text-sm leading-normal"
              onSubmit={(event) => {
                event.preventDefault();
                if (!auth?.flowId || !values.callback?.trim()) return;
                void run(() =>
                  complete({
                    environmentId,
                    input: { instanceId, flowId: auth.flowId!, callbackUrl: values.callback! },
                  }),
                ).then((sent) => {
                  if (sent) setDraft({ id: "", values: {} });
                });
              }}
            >
              <label className="grid gap-1">
                {acceptsCode
                  ? "Paste the code from Claude"
                  : "If the final localhost page does not load, paste its full URL here."}
                <Input
                  size="sm"
                  id={`provider-callback-${instanceId}`}
                  type={acceptsCode ? "text" : "url"}
                  autoCapitalize="none"
                  spellCheck={false}
                  autoComplete="off"
                  value={values.callback ?? ""}
                  disabled={disabled}
                  maxLength={acceptsCode ? 4096 : 16_384}
                  onChange={(event) => updateDraft("callback", event.target.value)}
                />
              </label>
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="w-fit"
                disabled={disabled || !values.callback?.trim()}
              >
                Continue
              </Button>
            </form>
          ) : null}
          {error || query.error ? (
            <p role="alert" className="py-2 text-xs text-destructive">
              {error ?? query.error}
            </p>
          ) : null}
        </>
      ) : null}
    </SettingsRow>
  );
}
