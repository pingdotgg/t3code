import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProviderProxyAccount,
  type ProviderProxyHost,
  type ProviderProxyLogin,
  type ProviderProxyLoginProvider,
  type ProviderProxyRuntimeStatus,
  providerProxyHost,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { providerProxyEnvironment } from "../../state/providerProxy";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SecretInput } from "./SecretInput";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const CONTROL_CLASS = "w-full min-w-0 @min-[32rem]/settings-row:w-56";

const HOST_LABELS: Record<ProviderProxyHost, string> = {
  off: "Off",
  managed: "This environment",
  external: "External URL",
};

const HOST_DESCRIPTIONS: Record<ProviderProxyHost, string> = {
  off: "Send Claude, Codex, and OpenCode requests through a CLIProxyAPI server, which spreads them across several accounts.",
  managed:
    "T3 Code downloads CLIProxyAPI from GitHub and runs it on this machine. Turn on Use proxy for a Claude, Codex, or OpenCode provider to send its requests here.",
  external:
    "A CLIProxyAPI server you run. Turn on Use proxy for a Claude, Codex, or OpenCode provider to send its requests here.",
};

const PROVIDER_LABELS: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex" };
const LOGIN_PROVIDERS: ReadonlyArray<ProviderProxyLoginProvider> = ["claude", "codex"];

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

function runtimeDescription(runtime: ProviderProxyRuntimeStatus): string {
  switch (runtime.status) {
    case "stopped":
      return "Stopped.";
    case "installing":
      return "Downloading CLIProxyAPI…";
    case "starting":
      return "Starting…";
    case "running":
      return runtime.version ? `Running CLIProxyAPI ${runtime.version}.` : "Running.";
    case "error":
      return runtime.message ?? "CLIProxyAPI stopped. Restarting…";
  }
}

function accountStateDescription(account: ProviderProxyAccount): string {
  switch (account.state) {
    case "active":
      return "Active";
    case "disabled":
      return "Disabled";
    case "cooldown":
      return account.retryAt
        ? `Cooling down until ${new Date(account.retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
        : "Cooling down";
    case "error":
      return account.statusMessage ? `Error: ${account.statusMessage}` : "Error";
  }
}

/** Secrets arrive redacted: any non-empty value means one is stored. */
export function ProviderProxySettings({
  environmentId,
  proxy,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly proxy: UnifiedSettings["providerProxy"];
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const update = (patch: Partial<UnifiedSettings["providerProxy"]>) =>
    updateSettings({ providerProxy: patch });
  const host = providerProxyHost(proxy);
  // The server reads proxy state only for sessions that can manage providers.
  const canManageProviders = useAtomValue(
    providerProxyEnvironment.startLogin.permissionAtom(environmentId),
  );
  const managesAccounts =
    canManageProviders &&
    (host === "managed" || (host === "external" && proxy.managementKey !== ""));

  return (
    <SettingsSection {...searchableSetting("provider-proxy")}>
      <SettingsRow
        id="provider-proxy-host"
        title="Proxy"
        description={HOST_DESCRIPTIONS[host]}
        control={
          <div className={CONTROL_CLASS}>
            <Select
              value={host}
              disabled={readOnly}
              onValueChange={(value) => {
                if (value === "off" || value === "managed" || value === "external") {
                  update({ host: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Proxy host">
                <SelectValue>{HOST_LABELS[host]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="off">{HOST_LABELS.off}</SelectItem>
                <SelectItem value="managed">{HOST_LABELS.managed}</SelectItem>
                <SelectItem value="external">{HOST_LABELS.external}</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        }
      />
      {host === "external" ? (
        <ExternalProxyRows proxy={proxy} readOnly={readOnly} update={update} />
      ) : null}
      {managesAccounts ? (
        <ProxyAccountRows environmentId={environmentId} showRuntime={host === "managed"} />
      ) : null}
    </SettingsSection>
  );
}

function ExternalProxyRows({
  proxy,
  readOnly,
  update,
}: {
  readonly proxy: UnifiedSettings["providerProxy"];
  readonly readOnly: boolean;
  readonly update: (patch: Partial<UnifiedSettings["providerProxy"]>) => void;
}) {
  return (
    <>
      <SettingsRow
        id="provider-proxy-url"
        title={<label htmlFor="provider-proxy-url-input">Proxy URL</label>}
        control={
          <DraftInput
            id="provider-proxy-url-input"
            size="sm"
            className={CONTROL_CLASS}
            value={proxy.url}
            placeholder="http://192.168.1.10:8317"
            autoComplete="off"
            spellCheck={false}
            disabled={readOnly}
            onCommit={(url) => update({ url: url.trim() })}
          />
        }
      />
      <SecretRow
        id="provider-proxy-api-key"
        title="API key"
        description="One of the proxy's API keys. Leave empty if the proxy has none."
        configured={proxy.apiKey !== ""}
        readOnly={readOnly}
        onCommit={(apiKey) => update({ apiKey })}
      />
      <SecretRow
        id="provider-proxy-management-key"
        title="Management key"
        description="Optional. Lists the proxy's accounts here and under Usage → Limits."
        configured={proxy.managementKey !== ""}
        readOnly={readOnly}
        onCommit={(managementKey) => update({ managementKey })}
      />
    </>
  );
}

function SecretRow({
  id,
  title,
  description,
  configured,
  readOnly,
  onCommit,
}: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly configured: boolean;
  readonly readOnly: boolean;
  readonly onCommit: (value: string) => void;
}) {
  return (
    <SettingsRow
      id={id}
      title={<label htmlFor={`${id}-input`}>{title}</label>}
      description={description}
      control={
        <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-56">
          <SecretInput
            id={`${id}-input`}
            size="sm"
            className="min-w-0 flex-1"
            value=""
            configured={configured}
            disabled={readOnly}
            onCommit={(value) => onCommit(value.trim())}
          />
          {configured && !readOnly ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-destructive"
              onClick={() => onCommit("")}
              aria-label={`Clear ${title.toLowerCase()}`}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

function ProxyAccountRows({
  environmentId,
  showRuntime,
}: {
  readonly environmentId: EnvironmentId;
  readonly showRuntime: boolean;
}) {
  const state = useEnvironmentQuery(providerProxyEnvironment.state({ environmentId, input: {} }));
  const canAdd = useAtomValue(providerProxyEnvironment.startLogin.permissionAtom(environmentId));
  const startLogin = useAtomCommand(providerProxyEnvironment.startLogin, {
    label: "start proxy sign-in",
  });
  const [login, setLogin] = useState<
    (ProviderProxyLogin & { readonly provider: ProviderProxyLoginProvider }) | null
  >(null);
  const [starting, setStarting] = useState(false);

  const add = async (provider: ProviderProxyLoginProvider) => {
    setStarting(true);
    const result = await startLogin({ environmentId, input: { provider } });
    setStarting(false);
    if (result._tag === "Success") setLogin({ ...result.value, provider });
    else if (!isAtomCommandInterrupted(result)) {
      failureToast("Could not start sign-in", String(squashAtomCommandFailure(result)));
    }
  };

  if (state.error) {
    return <SettingsRow title="Could not read the proxy" description={state.error} />;
  }
  const data = state.data;
  if (!data) return <SettingsRow title="Loading proxy…" role="status" />;
  const accounts = data.accounts ?? [];
  const providers = [
    ...new Set([...LOGIN_PROVIDERS, ...accounts.map((account) => account.provider)]),
  ];

  return (
    <>
      {showRuntime ? (
        <SettingsRow
          id="provider-proxy-status"
          title="Status"
          description={runtimeDescription(data.runtime)}
          role="status"
        />
      ) : null}
      {data.accountsError ? (
        <SettingsRow title="Could not list accounts" description={data.accountsError} />
      ) : null}
      {data.accounts === null ? null : (
        <SettingsRow
          id="provider-proxy-accounts"
          title="Accounts"
          description={
            accounts.length === 0
              ? "Sign in to Claude or ChatGPT accounts. The proxy spreads requests across them."
              : "The proxy spreads requests across active accounts and keeps each thread on one."
          }
          control={
            canAdd ? (
              <div className="flex shrink-0 items-center gap-2">
                {LOGIN_PROVIDERS.map((provider) => (
                  <Button
                    key={provider}
                    size="xs"
                    variant="outline"
                    disabled={starting || login !== null}
                    onClick={() => void add(provider)}
                  >
                    Add {PROVIDER_LABELS[provider]}
                  </Button>
                ))}
              </div>
            ) : null
          }
        />
      )}
      {login === null ? null : (
        <ProxyLoginRow environmentId={environmentId} login={login} onDone={() => setLogin(null)} />
      )}
      {providers.flatMap((provider) =>
        accounts
          .filter((account) => account.provider === provider)
          .map((account) => (
            <ProxyAccountRow
              key={account.name}
              environmentId={environmentId}
              account={account}
              providerLabel={PROVIDER_LABELS[provider] ?? provider}
            />
          )),
      )}
    </>
  );
}

function ProxyLoginRow({
  environmentId,
  login,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly login: ProviderProxyLogin & { readonly provider: ProviderProxyLoginProvider };
  readonly onDone: () => void;
}) {
  const status = useEnvironmentQuery(
    providerProxyEnvironment.loginStatus({ environmentId, input: { state: login.state } }),
  );
  const completeLogin = useAtomCommand(providerProxyEnvironment.completeLogin, {
    label: "finish proxy sign-in",
  });
  const [redirectUrl, setRedirectUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const label = PROVIDER_LABELS[login.provider] ?? login.provider;
  const outcome = status.data?.status;

  const open = () => {
    void ensureLocalApi()
      .shell.openExternal(login.url)
      .catch(() =>
        failureToast("Could not open the sign-in page", "Copy the link and open it yourself."),
      );
  };
  const submit = async () => {
    setSubmitting(true);
    const result = await completeLogin({
      environmentId,
      input: { state: login.state, redirectUrl: redirectUrl.trim() },
    });
    setSubmitting(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast("Could not finish sign-in", String(squashAtomCommandFailure(result)));
    }
  };

  const description =
    outcome === "ok"
      ? `${label} account added.`
      : outcome === "error"
        ? (status.data?.message ?? "Sign-in failed.")
        : "Open the sign-in page. When the browser lands on a localhost address that does not load, copy that address and paste it here.";

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="space-y-3">
        <div className={ITEM_ROW_INNER_CLASSNAME}>
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-sm font-medium text-foreground">Add a {label} account</h3>
            <p className="text-xs text-muted-foreground" role="status">
              {description}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {outcome === "ok" || outcome === "error" ? (
              <Button size="xs" variant="outline" onClick={onDone}>
                Done
              </Button>
            ) : (
              <>
                <Button size="xs" variant="outline" onClick={open}>
                  Open sign-in page
                </Button>
                <Button size="xs" variant="ghost" onClick={onDone}>
                  Cancel
                </Button>
              </>
            )}
          </div>
        </div>
        {outcome === "ok" || outcome === "error" ? null : (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (redirectUrl.trim() !== "") void submit();
            }}
          >
            <Input
              size="sm"
              className="min-w-0 flex-1"
              value={redirectUrl}
              placeholder="http://localhost:…/callback?code=…&state=…"
              aria-label="Address the browser landed on"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setRedirectUrl(event.target.value)}
            />
            <Button
              type="submit"
              size="xs"
              variant="outline"
              disabled={submitting || redirectUrl.trim() === ""}
            >
              Finish
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

function ProxyAccountRow({
  environmentId,
  account,
  providerLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly account: ProviderProxyAccount;
  readonly providerLabel: string;
}) {
  const setDisabled = useAtomCommand(providerProxyEnvironment.setAccountDisabled, {
    label: "change proxy account",
  });
  const remove = useAtomCommand(providerProxyEnvironment.removeAccount, {
    label: "remove proxy account",
  });
  const canChange = useAtomValue(
    providerProxyEnvironment.setAccountDisabled.permissionAtom(environmentId),
  );
  const canRemove = useAtomValue(
    providerProxyEnvironment.removeAccount.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const title = account.email ?? account.name;
  const disabled = account.state === "disabled";

  const toggle = async () => {
    setBusy(true);
    const result = await setDisabled({
      environmentId,
      input: { name: account.name, disabled: !disabled },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast(
        disabled ? "Could not enable the account" : "Could not disable the account",
        String(squashAtomCommandFailure(result)),
      );
    }
  };
  const removeAccount = async () => {
    const confirmed = await (requestConfirmDialog(
      `Remove ${title} from the proxy? Its sign-in is deleted; add it again to use it.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await remove({ environmentId, input: { name: account.name } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast("Could not remove the account", String(squashAtomCommandFailure(result)));
    }
  };

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="truncate text-sm font-medium text-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground">
            {providerLabel} · {accountStateDescription(account)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canChange ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void toggle()}>
              {disabled ? "Enable" : "Disable"}
            </Button>
          ) : null}
          {canRemove ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void removeAccount()}
            >
              Remove
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
