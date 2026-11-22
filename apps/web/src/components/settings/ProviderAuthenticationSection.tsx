import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
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
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { lazy, Suspense, useRef, useState } from "react";
import { CopyIcon } from "lucide-react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { isWebUrl } from "../../browser/webUrl";
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
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const target = { environmentId, input: { instanceId } };
  const query = useEnvironmentQuery(serverEnvironment.providerAuthState(target), useMessages());
  const commands = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, commands);
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, commands);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, commands);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, commands);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, commands);
  const [methodId, setMethodId] = useState("");
  const [draft, setDraft] = useState({ id: "", values: {} as Record<string, string> });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const terminalQueue = useRef<ProviderAuthRespondInput[]>([]);
  const terminalSending = useRef(false);
  const auth = query.data;
  const interaction = auth?.interaction;
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
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
      ? (auth.message ?? (usesCredentials ? gt("Connecting…") : gt("Starting sign-in…")))
      : auth?.phase === "verifying"
        ? usesCredentials
          ? gt("Checking credentials and loading models…")
          : gt("Checking your account…")
        : interaction?.type === "terminal"
          ? gt("Complete sign-in in the terminal below.")
          : interaction?.type === "credentials"
            ? gt("Enter your credentials below.")
            : gt("Finish signing in in your browser.")
    : signedIn
      ? gt("Signed in.")
      : isDiscovering
        ? gt("Discovering sign-in methods…")
        : needsExternalSetup
          ? gt("No in-app sign-in advertised. Follow the provider's docs to finish setup.")
          : usesCredentials
            ? gt("Connect on {environment} to load models.", { environment: environmentLabel })
            : gt("Sign in on {environment}.", { environment: environmentLabel });
  const statusMessage = auth?.phase === "failed" ? auth.message : null;
  const disabled = readOnly || pending || query.error !== null || isDiscovering;
  const draftId = `${auth?.flowId ?? ""}:${interaction?.id ?? ""}`;
  const values = draft.id === draftId ? draft.values : {};
  const url =
    interaction?.type === "browser" || interaction?.type === "deviceCode"
      ? interaction.url
      : auth?.authorizationUrl;

  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
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
        setError(
          failure instanceof Error
            ? (thrownErrorMessage(failure, m) ?? failure.message)
            : gt("Provider sign-in failed. Try again."),
        );
      }
    } catch {
      setError(gt("Provider sign-in failed. Try again."));
    }
    pendingRef.current = false;
    setPending(false);
    return succeeded;
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
    if (!isWebUrl(url)) {
      setError(gt("This sign-in link is not a web address, so it was not opened."));
      return;
    }
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
      setError(gt("Could not open the sign-in page. Copy the link and open it in your browser."));
    }
  }

  function updateDraft(name: string, value: string) {
    setDraft({ id: draftId, values: { ...values, [name]: value } });
  }

  return (
    <SettingsRow
      title={gt("Account")}
      description={
        signedIn && !active && provider.auth.email?.trim() ? (
          <span>
            <T>
              Signed in as{" "}
              <RedactedSensitiveText
                key={provider.auth.email}
                value={provider.auth.email}
                ariaLabel={gt("Toggle account email visibility")}
                revealTooltip={gt("Click to reveal email")}
                hideTooltip={gt("Click to hide email")}
                className="max-w-full truncate"
              />
            </T>
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
        ) : undefined
      }
      control={
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {!active && (auth?.methods?.length ?? 0) > 1 ? (
            <Select
              value={auth?.methods?.some((method) => method.id === methodId) ? methodId : ""}
              disabled={disabled}
              onValueChange={(value) => setMethodId(value ?? "")}
            >
              <SelectTrigger size="sm" aria-label={gt("Sign-in method")} className="w-44">
                <SelectValue>
                  {auth?.methods?.find((method) => method.id === methodId)?.name ??
                    gt("Provider default")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="">
                  <T>Provider default</T>
                </SelectItem>
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
                variant="secondary"
                disabled={disabled}
                onClick={() => void openBrowser()}
              >
                <T>Open browser</T>
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={gt("Copy sign-in link")}
                      size="icon-sm"
                      variant="ghost-muted"
                      disabled={disabled}
                      onClick={() => {
                        // Copy during the click to retain clipboard activation; consent must still be
                        // recorded before use.
                        const copied = writeTextToClipboard(url, {
                          target: "Provider sign-in link",
                          unavailableMessage: msg(
                            "Clipboard API is unavailable while copying Provider sign-in link.",
                          ),
                          failureMessage: msg(
                            "Failed to copy Provider sign-in link to the clipboard.",
                          ),
                        });
                        void (async () => {
                          await copied;
                          if (interaction?.type === "browser" && interaction.requiresConsent)
                            await send({ type: "browser", action: "accept" });
                        })().catch(() => setError(gt("Could not copy the sign-in link.")));
                      }}
                    >
                      <CopyIcon />
                    </Button>
                  }
                />
                <TooltipPopup>
                  <T>Copy sign-in link</T>
                </TooltipPopup>
              </Tooltip>
            </>
          ) : null}
          <>
            {needsExternalSetup && provider.setup?.documentationUrl ? (
              <Button
                size="sm"
                variant="secondary"
                render={
                  <a href={provider.setup.documentationUrl} target="_blank" rel="noreferrer" />
                }
              >
                <T>Open docs</T>
              </Button>
            ) : active && auth?.flowId ? (
              <Button
                size="sm"
                variant="ghost-muted"
                aria-label={gt("Cancel sign-in")}
                disabled={disabled}
                onClick={() =>
                  void run(() =>
                    cancel({ environmentId, input: { instanceId, flowId: auth.flowId! } }),
                  )
                }
              >
                <T>Cancel</T>
              </Button>
            ) : !active && !needsExternalSetup && provider.setup?.canAuthenticate !== false ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled || !provider.enabled || !provider.installed || !auth}
                onClick={() =>
                  void run(() =>
                    start({
                      environmentId,
                      input: {
                        instanceId,
                        ...(methodId && auth?.methods?.some((method) => method.id === methodId)
                          ? { methodId }
                          : {}),
                      },
                    }),
                  )
                }
              >
                {signedIn
                  ? gt("Change account")
                  : auth?.phase === "failed" || auth?.phase === "cancelled"
                    ? usesCredentials
                      ? gt("Retry connection")
                      : gt("Retry sign-in")
                    : usesCredentials
                      ? gt("Connect")
                      : gt("Sign in")}
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
                      gt(
                        "Sign out of {provider} on {environment}? This stops running threads that share this sign-in. Thread history is kept.",
                        {
                          provider: provider.displayName ?? provider.driver,
                          environment: environmentLabel,
                        },
                      ),
                    )
                    .then((confirmed) => {
                      if (confirmed) void run(() => logout(target));
                    });
                }}
              >
                <T>Sign out</T>
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
              <T>
                Enter code{" "}
                <code className="select-all font-mono text-foreground">
                  <Var>{interaction.userCode}</Var>
                </code>{" "}
                in your browser.
              </T>
            </p>
          ) : null}
          {interaction?.type === "terminal" ? (
            <div className="py-2">
              <Suspense
                fallback={
                  <p className="text-xs text-muted-foreground">
                    <T>Loading sign-in terminal…</T>
                  </p>
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
                            setError(gt("The provider sign-in terminal is no longer available."));
                          break;
                        }
                      }
                    })()
                      .catch(() => {
                        terminalQueue.current = [];
                        setError(gt("Could not send input to the provider sign-in terminal."));
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
                variant="secondary"
                className="w-fit"
                disabled={disabled}
              >
                <T>Connect</T>
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
                <T>If the final localhost page does not load, paste its full URL here.</T>
                <Input
                  size="sm"
                  id={`provider-callback-${instanceId}`}
                  type="url"
                  autoComplete="off"
                  value={values.callback ?? ""}
                  disabled={disabled}
                  maxLength={16_384}
                  onChange={(event) => updateDraft("callback", event.target.value)}
                />
              </label>
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                className="w-fit"
                disabled={disabled || !values.callback?.trim()}
              >
                <T>Continue</T>
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
