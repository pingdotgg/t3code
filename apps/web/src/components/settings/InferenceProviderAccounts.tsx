import { T, Var, useGT, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  inferenceAccountRetryAfter,
  inferenceAccountStatus,
} from "@t3tools/client-runtime/state/inference-proxy";
import {
  type EnvironmentId,
  INFERENCE_HARNESSES,
  INFERENCE_UPSTREAMS,
  type InferenceDriver,
  type InferenceProxyAction,
  type InferenceUpstream,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SettingsRow } from "./settingsLayout";

const { inferenceProxy } = serverEnvironment;
const everyUpstream = Object.keys(INFERENCE_UPSTREAMS) as ReadonlyArray<InferenceUpstream>;

export function InferenceProviderAccounts({
  environmentId,
  driver,
  readOnly,
  hostLabel,
  enableLocalHosting,
  onAccountsChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver?: InferenceDriver;
  readonly readOnly?: boolean;
  readonly hostLabel?: string | undefined;
  readonly enableLocalHosting?: boolean;
  readonly onAccountsChanged?: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const permitted = useAtomValue(inferenceProxy.manageInference.permissionAtom(environmentId));
  const canManage = permitted && !readOnly;
  const supportsHostingGuard = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.inferenceConfigureGuard === true,
  );
  const canStartHosting = enableLocalHosting && supportsHostingGuard;
  const query = useEnvironmentQuery(
    canManage ? inferenceProxy.inferenceStatus({ environmentId, input: {} }) : null,
  );
  const command = useAtomCommand(inferenceProxy.manageInference, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ReactNode>("");
  const [login, setLogin] = useState<{ url: string; state: string } | null>(null);
  const [callback, setCallback] = useState("");
  const host = query.data;
  const accountSetup = useRef({ active: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prevents an account operation from routing after its setup view closes
  useEffect(() => {
    const setup = { active: true };
    accountSetup.current = setup;
    return () => {
      setup.active = false;
    };
  }, []);
  async function run(input: InferenceProxyAction) {
    const setup = accountSetup.current;
    setBusy(true);
    setNotice("");
    const result = await command({ environmentId, input });
    if (!setup.active) return;
    setBusy(false);
    if (result._tag === "Failure") {
      setNotice(String(squashAtomCommandFailure(result)));
      return;
    }
    if (result.value.login) {
      setLogin(result.value.login);
      setCallback("");
    }
    if (input.operation === "cancel" || result.value.status === "ok") {
      setLogin(null);
      setCallback("");
    }
    if (result.value.status === "wait")
      setNotice(<T>Waiting for sign-in to finish. Check status after completing sign-in.</T>);
    if (result.value.status === "error") {
      setLogin(null);
      setCallback("");
      setNotice(<T>Sign-in failed or expired. Start a new sign-in.</T>);
    }
    if (result.value.status === "ok" || (input.operation === "configure" && input.enabled))
      onAccountsChanged?.();
  }
  const hostName = hostLabel || gt("the inference host");
  const harness = driver ? INFERENCE_HARNESSES[driver] : undefined;
  if (!permitted)
    return (
      <SettingsRow
        title={gt("Connect to {host} to manage its accounts", { host: hostName })}
        description={gt(
          "This client needs a connection to that environment with provider management access.",
        )}
        control={
          <Button size="sm" variant="outline" render={<Link to="/settings/connections" />}>
            <T>Connections</T>
          </Button>
        }
      />
    );
  if (readOnly) return <SettingsRow title={gt("Accounts cannot be changed from this view.")} />;
  if (!host) return <SettingsRow title={query.error ?? gt("Loading accounts…")} />;
  if (!host.enabled)
    return (
      <SettingsRow
        title={gt("Inference hosting is off on {host}", { host: hostName })}
        description={
          canStartHosting
            ? gt("Install and start CLIProxyAPI on this environment to use its accounts.")
            : gt("Turn hosting on there to add and share accounts.")
        }
        status={notice || undefined}
        control={
          canStartHosting ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run({
                  operation: "configure",
                  enabled: true,
                  sharing: false,
                  expectedEnabled: false,
                })
              }
            >
              <T>Start hosting here</T>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              render={<Link to="/settings/inference" search={{ machine: environmentId }} />}
            >
              <T>Inference accounts</T>
            </Button>
          )
        }
      />
    );
  return (
    <>
      {host.accounts
        .filter((account) => harness?.accounts?.includes(account.provider) ?? true)
        .map((account) => {
          const retryAfter = inferenceAccountRetryAfter(account);
          return (
            <SettingsRow
              key={account.name}
              title={
                <RedactedSensitiveText
                  value={account.name}
                  ariaLabel={gt("Toggle account name visibility")}
                  revealTooltip={gt("Click to reveal account name")}
                  hideTooltip={gt("Click to hide account name")}
                  className="max-w-full wrap-anywhere text-left"
                />
              }
              description={`${account.provider} · ${inferenceAccountStatus(account, messages)}`}
              status={
                retryAfter ? (
                  <time dateTime={retryAfter}>
                    <T>
                      Retry after <Var>{new Date(retryAfter).toLocaleString()}</Var>
                    </T>
                  </time>
                ) : undefined
              }
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run({ operation: "removeAccount", name: account.name })}
                >
                  <T>Remove</T>
                </Button>
              }
            />
          );
        })}
      {login ? (
        <>
          <SettingsRow
            title={gt("Finish signing in")}
            description={gt(
              "Open the provider sign-in page and paste the final localhost URL here, even if the browser cannot load it.",
            )}
            control={
              <Button
                size="sm"
                variant="outline"
                render={<a href={login.url} target="_blank" rel="noreferrer" />}
              >
                <T>Open sign-in</T>
              </Button>
            }
          />
          <Input
            aria-label={gt("Sign-in callback URL")}
            placeholder={gt("Paste callback URL")}
            type="password"
            value={callback}
            onChange={(event) => setCallback(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !callback}
              onClick={() => void run({ operation: "callback", state: login.state, callback })}
            >
              <T>Submit</T>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run({ operation: "check", state: login.state })}
            >
              <T>Check status</T>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run({ operation: "cancel", state: login.state })}
            >
              <T>Cancel</T>
            </Button>
          </div>
        </>
      ) : (
        <SettingsRow
          title={gt("Add an account")}
          description={gt("Sign in once for each account this host should use.")}
          control={
            <div className="flex flex-wrap justify-end gap-2">
              {(harness?.upstreams ?? everyUpstream).map((upstream) => (
                <Button
                  key={upstream}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run({ operation: "signIn", upstream })}
                >
                  {INFERENCE_UPSTREAMS[upstream]}
                </Button>
              ))}
            </div>
          }
        />
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </>
  );
}
