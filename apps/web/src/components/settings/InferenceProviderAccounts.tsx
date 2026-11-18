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
import { useState } from "react";
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
}: {
  readonly environmentId: EnvironmentId;
  readonly driver?: InferenceDriver;
  readonly readOnly?: boolean;
  readonly hostLabel?: string | undefined;
}) {
  const permitted = useAtomValue(inferenceProxy.manageInference.permissionAtom(environmentId));
  const canManage = permitted && !readOnly;
  const query = useEnvironmentQuery(
    canManage ? inferenceProxy.inferenceStatus({ environmentId, input: {} }) : null,
  );
  const command = useAtomCommand(inferenceProxy.manageInference, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [login, setLogin] = useState<{ url: string; state: string } | null>(null);
  const [callback, setCallback] = useState("");
  const host = query.data;
  async function run(input: InferenceProxyAction) {
    setBusy(true);
    setNotice("");
    const result = await command({ environmentId, input });
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
      setNotice("Waiting for sign-in to finish. Check status after completing sign-in.");
    if (result.value.status === "error") {
      setLogin(null);
      setCallback("");
      setNotice("Sign-in failed or expired. Start a new sign-in.");
    }
  }
  const hostName = hostLabel || "the inference host";
  const harness = driver ? INFERENCE_HARNESSES[driver] : undefined;
  if (!permitted)
    return (
      <SettingsRow
        title={`Connect to ${hostName} to manage its accounts`}
        description="This client needs a connection to that environment with provider management access."
        control={
          <Button size="sm" variant="outline" render={<Link to="/settings/connections" />}>
            Connections
          </Button>
        }
      />
    );
  if (readOnly) return <SettingsRow title="Accounts cannot be changed from this view." />;
  if (!host) return <SettingsRow title={query.error ?? "Loading accounts…"} />;
  if (!host.enabled)
    return (
      <SettingsRow
        title={`Inference hosting is off on ${hostName}`}
        description="Turn hosting on there to add and share accounts."
        control={
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/settings/inference" search={{ machine: environmentId }} />}
          >
            Inference accounts
          </Button>
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
                  ariaLabel="Toggle account name visibility"
                  revealTooltip="Click to reveal account name"
                  hideTooltip="Click to hide account name"
                  className="max-w-full wrap-anywhere text-left"
                />
              }
              description={`${account.provider} · ${inferenceAccountStatus(account)}`}
              status={
                retryAfter ? (
                  <time dateTime={retryAfter}>
                    Retry after {new Date(retryAfter).toLocaleString()}
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
                  Remove
                </Button>
              }
            />
          );
        })}
      {login ? (
        <>
          <SettingsRow
            title="Finish signing in"
            description="Open the provider sign-in page and paste the final localhost URL here, even if the browser cannot load it."
            control={
              <Button
                size="sm"
                variant="outline"
                render={<a href={login.url} target="_blank" rel="noreferrer" />}
              >
                Open sign-in
              </Button>
            }
          />
          <Input
            aria-label="Sign-in callback URL"
            placeholder="Paste callback URL"
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
              Submit
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run({ operation: "check", state: login.state })}
            >
              Check status
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run({ operation: "cancel", state: login.state })}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <SettingsRow
          title="Add an account"
          description="Sign in once for each account this host should use."
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
