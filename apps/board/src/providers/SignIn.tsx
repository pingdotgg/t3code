import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { type AtomCommandResult, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProviderAuthResponse,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useContext, useState } from "react";

import { failureText } from "../settings/failureText";
import { serverEnvironment } from "../state/server";
import type { PickableInstance } from "./providers";

const button =
  "rounded-md border border-line px-2 py-0.5 text-fg hover:bg-hover disabled:opacity-50";
const field =
  "min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-fg placeholder:text-faint";

const ACTIVE_PHASES: ReadonlySet<string> = new Set(["starting", "waiting", "verifying"]);

/** Runs the engine's sign-in for a signed-out instance and shows the step it is waiting on. */
export function SignIn({
  environmentId,
  instance,
}: {
  environmentId: EnvironmentId;
  instance: PickableInstance;
}) {
  const registry = useContext(RegistryContext);
  const instanceId = ProviderInstanceId.make(instance.instanceId);
  const auth = AsyncResult.getOrElse(
    useAtomValue(serverEnvironment.providerAuthState({ environmentId, input: { instanceId } })),
    () => null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});

  const act = async (command: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setBusy(true);
    setError(null);
    const result = await command();
    if (result._tag !== "Success") setError(failureText(result));
    setBusy(false);
    return result._tag === "Success";
  };
  const refresh = () =>
    act(() =>
      runAtomCommand(
        registry,
        serverEnvironment.refreshProviders,
        { environmentId, input: { instanceId, fresh: true } },
        { reportFailure: false },
      ),
    );

  if (!instance.canSignIn) {
    return (
      <div className="flex flex-col gap-1.5 text-muted">
        <p>
          {instance.message ??
            `T3 cannot sign ${instance.name} in. Sign in on the machine that runs T3, then refresh.`}
        </p>
        <div>
          <button type="button" className={button} disabled={busy} onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        {error !== null && (
          <p role="alert" className="break-words text-red-400">
            {error}
          </p>
        )}
      </div>
    );
  }

  const interaction = auth?.interaction ?? null;
  const active = auth !== null && ACTIVE_PHASES.has(auth.phase);
  const flowId = auth?.flowId ?? null;
  const respond = (response: ProviderAuthResponse) =>
    interaction === null || flowId === null
      ? Promise.resolve(false)
      : act(() =>
          runAtomCommand(
            registry,
            serverEnvironment.respondProviderAuth,
            {
              environmentId,
              input: { instanceId, flowId, interactionId: interaction.id, response },
            },
            { reportFailure: false },
          ),
        );

  const start = () =>
    act(() =>
      runAtomCommand(
        registry,
        serverEnvironment.startProviderAuth,
        { environmentId, input: { instanceId } },
        { reportFailure: false },
      ),
    );
  const cancel = () =>
    flowId === null
      ? Promise.resolve(false)
      : act(() =>
          runAtomCommand(
            registry,
            serverEnvironment.cancelProviderAuth,
            { environmentId, input: { instanceId, flowId } },
            { reportFailure: false },
          ),
        );

  const openPage = async (url: string, needsConsent: boolean) => {
    // The tab is opened before the await, because a browser blocks a tab opened after it.
    const tab = needsConsent ? window.open("", "_blank") : null;
    if (tab !== null) tab.opener = null;
    if (needsConsent && !(await respond({ type: "browser", action: "accept" }))) {
      tab?.close();
      return;
    }
    if (tab === null) window.open(url, "_blank", "noopener");
    else tab.location.href = url;
  };

  const submit = (event: FormEvent, response: ProviderAuthResponse) => {
    event.preventDefault();
    void respond(response);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {auth?.message && auth.phase !== "failed" && <p className="text-muted">{auth.message}</p>}
      {interaction?.type === "browser" && (
        <>
          <p className="text-muted">Finish signing in in your browser.</p>
          <div>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void openPage(interaction.url, interaction.requiresConsent)}
            >
              Open the sign-in page
            </button>
          </div>
          {interaction.acceptsCallback === true && flowId !== null && (
            <form
              className="flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void act(() =>
                  runAtomCommand(
                    registry,
                    serverEnvironment.completeProviderAuth,
                    { environmentId, input: { instanceId, flowId, callbackUrl: typed.trim() } },
                    { reportFailure: false },
                  ),
                );
              }}
            >
              <input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder="Paste the address you were sent back to"
                aria-label="Callback address"
                className={`${field} flex-1`}
              />
              <button type="submit" className={button} disabled={busy || typed.trim() === ""}>
                Finish
              </button>
            </form>
          )}
        </>
      )}
      {interaction?.type === "deviceCode" && (
        <p className="text-muted">
          Open{" "}
          <a
            href={interaction.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-fg underline"
          >
            {interaction.url}
          </a>{" "}
          and enter <code className="text-fg">{interaction.userCode}</code>.
        </p>
      )}
      {interaction?.type === "terminal" && (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            submit(event, { type: "terminal", data: `${typed}\r` });
            setTyped("");
          }}
        >
          <pre className="max-h-32 overflow-auto rounded-md border border-line bg-bg p-1.5 text-[11px] break-words whitespace-pre-wrap text-muted">
            {interaction.output}
          </pre>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            aria-label="Terminal input"
            className={field}
          />
        </form>
      )}
      {interaction?.type === "credentials" && (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => submit(event, { type: "credentials", values })}
        >
          {interaction.fields.map((entry) => (
            <input
              key={entry.name}
              type={entry.secret ? "password" : "text"}
              value={values[entry.name] ?? ""}
              onChange={(event) => setValues({ ...values, [entry.name]: event.target.value })}
              placeholder={entry.label}
              aria-label={entry.label}
              className={field}
            />
          ))}
          <div>
            <button type="submit" className={button} disabled={busy}>
              Connect
            </button>
          </div>
        </form>
      )}
      <div className="flex items-center gap-2">
        {active ? (
          <button type="button" className={button} disabled={busy} onClick={() => void cancel()}>
            Cancel sign-in
          </button>
        ) : (
          <button type="button" className={button} disabled={busy} onClick={() => void start()}>
            Sign in
          </button>
        )}
        <button
          type="button"
          className="text-muted hover:text-fg"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </div>
      {auth?.phase === "failed" && auth.message && (
        <p role="alert" className="break-words text-red-400">
          {auth.message}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="break-words text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
