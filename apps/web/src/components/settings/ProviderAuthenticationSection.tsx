import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderAuthResponse,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

/** All actions target the provider's environment, even when the browser is on another device. */
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
  const target = { environmentId, input: { instanceId } };
  const query = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
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
  const auth = query.data;
  const interaction = auth?.interaction;
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const disabled = readOnly || pending || query.error !== null;
  const draftId = interaction?.id ?? auth?.flowId ?? "";
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
    try {
      const result = await command();
      if (result._tag === "Success") return true;
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : "Provider sign-in failed. Try again.",
        );
      }
    } catch {
      setError("Provider sign-in failed. Try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
    return false;
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
    try {
      // Consent is checked on the environment before opening a provider URL locally.
      if (
        interaction?.type === "browser" &&
        interaction.requiresConsent &&
        !(await send({ type: "browser", action: "accept" }))
      )
        return;
      await ensureLocalApi().shell.openExternal(url);
      setError(null);
    } catch {
      setError("Could not open the sign-in page. Copy the link and open it in your browser.");
    }
  }

  function updateDraft(name: string, value: string) {
    setDraft({ id: draftId, values: { ...values, [name]: value } });
  }

  return (
    <SettingsRow
      title="Account"
      description={`Sign in on ${environmentLabel}.`}
      control={
        <div className="flex min-w-0 flex-col gap-2 sm:max-w-72 sm:items-end sm:text-right">
          <p role="status" className="text-muted-foreground [overflow-wrap:anywhere]">
            {active || auth?.phase === "failed" || auth?.phase === "cancelled"
              ? auth?.message
              : provider.auth.status === "authenticated"
                ? provider.auth.email
                  ? `Signed in as ${provider.auth.email}.`
                  : "Signed in."
                : auth?.phase === "idle"
                  ? (auth.message ?? "Connect this provider.")
                  : "Connect this provider."}
          </p>
          {!active && (auth?.methods?.length ?? 0) > 1 ? (
            <label className="grid gap-1">
              Sign-in method
              <select
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                value={auth?.methods?.some((method) => method.id === methodId) ? methodId : ""}
                disabled={disabled}
                onChange={(event) => setMethodId(event.target.value)}
              >
                <option value="">Provider default</option>
                {auth?.methods?.map((method) => (
                  <option key={method.id} value={method.id}>
                    {method.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {url ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => void openBrowser()}
              >
                Open sign-in page
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  void (async () => {
                    if (
                      interaction?.type === "browser" &&
                      interaction.requiresConsent &&
                      !(await send({ type: "browser", action: "accept" }))
                    )
                      return;
                    await writeTextToClipboard(url, "Provider sign-in link");
                  })().catch(() => setError("Could not copy the sign-in link."));
                }}
              >
                Copy sign-in link
              </Button>
            </div>
          ) : null}
          {interaction?.type === "deviceCode" ? (
            <p>
              Enter code <code className="select-all font-mono">{interaction.userCode}</code> on the
              sign-in page.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {active && auth?.flowId ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() =>
                  void run(() =>
                    cancel({ environmentId, input: { instanceId, flowId: auth.flowId! } }),
                  )
                }
              >
                Cancel sign-in
              </Button>
            ) : !active ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || !provider.enabled || !provider.installed || auth === null}
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
                {provider.auth.status === "authenticated"
                  ? "Change account"
                  : auth?.phase === "failed" || auth?.phase === "cancelled"
                    ? "Retry sign-in"
                    : "Sign in"}
              </Button>
            ) : null}
            {!active && (provider.auth.canLogout ?? provider.setup?.canAuthenticate) ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || auth === null}
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
          </div>
        </div>
      }
    >
      {interaction?.type === "terminal" ? (
        <div className="grid gap-2 py-2">
          <pre
            aria-label="Provider sign-in terminal"
            className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs"
          >
            {interaction.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")}
          </pre>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send({ type: "terminal", data: `${values.input ?? ""}\r` }).then((sent) => {
                if (sent) setDraft({ id: interaction.id, values: {} });
              });
            }}
          >
            <Input
              aria-label="Terminal response"
              type="password"
              autoComplete="off"
              value={values.input ?? ""}
              disabled={disabled}
              maxLength={4_095}
              onChange={(event) => updateDraft("input", event.target.value)}
            />
            <Button size="sm" variant="outline" type="submit" disabled={disabled}>
              Send
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void send({ type: "terminal", data: "\u0003" })}
            >
              Interrupt
            </Button>
          </form>
        </div>
      ) : null}
      {interaction?.type === "credentials" ? (
        <form
          className="grid gap-2 py-2"
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
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                value={values[field.name] ?? ""}
                disabled={disabled}
                maxLength={16_384}
                onChange={(event) => updateDraft(field.name, event.target.value)}
              />
            </label>
          ))}
          <Button type="submit" size="sm" variant="outline" className="w-fit" disabled={disabled}>
            Connect
          </Button>
        </form>
      ) : null}
      {url && (interaction?.type === "browser" ? interaction.acceptsCallback : !interaction) ? (
        <form
          className="grid gap-2 py-2"
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
            If the final localhost page does not load, paste its full URL here.
            <Input
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
            variant="outline"
            className="w-fit"
            disabled={disabled || !values.callback?.trim()}
          >
            Continue
          </Button>
        </form>
      ) : null}
      {auth?.expiresAt && active ? (
        <p className="text-muted-foreground">
          Sign-in expires at{" "}
          <time dateTime={auth.expiresAt}>{new Date(auth.expiresAt).toLocaleTimeString()}</time>.
        </p>
      ) : null}
      {error || query.error ? (
        <p role="alert" className="py-2 text-destructive">
          {error ?? query.error}
        </p>
      ) : null}
    </SettingsRow>
  );
}
