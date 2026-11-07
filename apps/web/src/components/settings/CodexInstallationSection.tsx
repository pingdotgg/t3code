import { useAtomValue } from "@effect/atom-react";
import { useId, useRef, useState } from "react";
import {
  AuthProvidersManageScope,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { formatBytes } from "../../lib/formatBytes";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { ManagedControl } from "../ManagedPolicy";
import { managedInstanceLocks, useManagedPolicy } from "../../state/managedPolicy";
import { SettingsRow } from "./settingsLayout";
import { isolatedCodexLoginCommand } from "./CodexSetupSection.logic";

export function CodexInstallationSection({
  environmentId,
  instanceId,
  readOnly = false,
  showLogin = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly readOnly?: boolean;
  readonly showLogin?: boolean;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const query = useEnvironmentQuery(
    serverEnvironment.providerInstallState({ environmentId, input: { instanceId } }),
  );
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const options = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderInstall, options);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderInstall, options);
  const remove = useAtomCommand(serverEnvironment.removeProviderInstallation, options);
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, options);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState<"install" | "cancel" | "remove" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const installation = query.data;
  const loginCommand =
    installation?.executablePath && provider?.runtimePaths?.homePath
      ? isolatedCodexLoginCommand(
          installation.executablePath,
          provider.runtimePaths.homePath,
          config?.environment.platform.os ?? "unknown",
        )
      : null;
  const running =
    installation !== null &&
    ["downloading", "extracting", "verifying"].includes(installation.phase);
  const disabled =
    readOnly || !canManage || pending !== null || query.error !== null || installation === null;
  const totalBytes = installation?.totalBytes;
  const downloading = installation?.phase === "downloading";
  const statusMessage =
    pending === "remove"
      ? "Removing Codex…"
      : pending === "cancel"
        ? "Cancelling installation…"
        : pending === "install"
          ? "Starting installation…"
          : running
            ? downloading && totalBytes && totalBytes > 0
              ? `${formatBytes(installation.downloadedBytes)} of ${formatBytes(totalBytes)}`
              : (installation.message ?? "Preparing Codex…")
            : installation?.installedVersion
              ? `Codex ${installation.installedVersion} installed`
              : installation?.phase === "cancelled"
                ? "Installation cancelled"
                : installation === null && query.isPending
                  ? "Checking installation…"
                  : "Not installed";
  const failure =
    error ?? query.error ?? (installation?.phase === "failed" ? installation.message : null);
  const perform = async (operation: "install" | "cancel" | "remove" | "refresh") => {
    if (disabled || pendingRef.current) return;
    if (operation === "cancel" && !installation?.operationId) return;
    pendingRef.current = true;
    setPending(operation);
    setError(null);
    const target = { environmentId, input: { instanceId } };
    const settled = await settlePromise(
      async () =>
        await (operation === "refresh"
          ? refresh(target)
          : operation === "cancel" && installation?.operationId
            ? cancel({
                environmentId,
                input: { instanceId, operationId: installation.operationId },
              })
            : operation === "remove"
              ? remove(target)
              : start(target)),
    );
    if (settled._tag === "Failure") {
      setError(
        operation === "refresh"
          ? "Could not refresh the account status. Reconnect and try again."
          : "Could not manage the Codex installation. Reconnect and try again.",
      );
    } else if (settled.value._tag === "Failure" && !isAtomCommandInterrupted(settled.value)) {
      const failure = squashAtomCommandFailure(settled.value);
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not manage the separate Codex installation.",
      );
    }
    pendingRef.current = false;
    setPending(null);
  };
  const confirmRemoval = async () => {
    if (disabled) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      "Remove the downloaded Codex installation? Providers using this package will need it reinstalled. Their settings, accounts, and conversations are kept.",
    );
    if (confirmed) await perform("remove");
  };
  return (
    <>
      <SettingsRow
        title="Codex installation"
        description="OpenAI’s official release, verified and installed on this environment."
        status={
          failure ? (
            <p role="alert" className="text-destructive">
              {failure}
            </p>
          ) : undefined
        }
        control={
          <div className="flex w-full min-w-0 flex-col gap-2 @min-[32rem]/settings-row:w-56 @min-[32rem]/settings-row:items-end">
            <p role="status" className="text-xs text-muted-foreground tabular-nums">
              {statusMessage}
            </p>
            {running ? (
              <progress
                aria-label="Codex installation progress"
                aria-valuetext={installation?.message ?? statusMessage}
                value={
                  downloading && totalBytes && totalBytes > 0
                    ? installation.downloadedBytes
                    : undefined
                }
                max={totalBytes && totalBytes > 0 ? totalBytes : undefined}
                className="block h-1 w-full overflow-hidden rounded-full bg-muted accent-primary forced-colors:border [&::-moz-progress-bar]:bg-primary forced-colors:[&::-moz-progress-bar]:bg-[Highlight] [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary forced-colors:[&::-webkit-progress-value]:bg-[Highlight]"
              />
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {running ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void perform("cancel")}
                >
                  Cancel installation
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant={installation?.installedVersion ? "outline" : "default"}
                    disabled={disabled}
                    onClick={() => void perform("install")}
                  >
                    {pending
                      ? "Working…"
                      : installation?.phase === "failed"
                        ? "Retry installation"
                        : installation?.installedVersion
                          ? "Reinstall Codex"
                          : "Install Codex"}
                  </Button>
                  {installation?.canRemove ? (
                    <Button
                      size="sm"
                      variant="ghost-destructive"
                      disabled={disabled}
                      onClick={() => void confirmRemoval()}
                    >
                      Remove installation
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          </div>
        }
      />
      {provider?.runtimePaths?.homePath ? (
        <CodexRuntimePath label="CODEX_HOME path" value={provider.runtimePaths.homePath} />
      ) : null}
      {installation?.executablePath ? (
        <CodexRuntimePath label="Binary path" value={installation.executablePath} />
      ) : null}
      {showLogin ? (
        <>
          <SettingsRow
            title="CLI or proxy account"
            description={
              loginCommand
                ? "Run the command in this environment's terminal. Open its URL on any device and enter the code. Enable ChatGPT device code authentication if prompted. For a proxy, configure the separate home above."
                : "Install Codex to get a login command for this environment. For a proxy, configure the separate home above."
            }
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || running || !provider?.enabled}
                onClick={() => void perform("refresh")}
              >
                {pending === "refresh" ? "Refreshing…" : "Refresh account status"}
              </Button>
            }
          />
          {loginCommand ? <CodexRuntimePath label="Login command" value={loginCommand} /> : null}
        </>
      ) : null}
    </>
  );
}

function CodexRuntimePath({ label, value }: { readonly label: string; readonly value: string }) {
  const [error, setError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: label,
    onError: (cause) => setError(cause.message),
  });
  return (
    <SettingsRow
      title={label}
      status={
        error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : undefined
      }
      control={
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-80">
          <Input aria-label={label} value={value} title={value} readOnly className="min-w-0" />
          <Button
            size="sm"
            variant="outline"
            className="min-w-16"
            aria-label={`Copy ${label}`}
            onClick={() => {
              setError(null);
              copyToClipboard(value);
            }}
          >
            {isCopied ? "Copied" : "Copy"}
          </Button>
          <span role="status" className="sr-only">
            {isCopied ? `${label} copied` : null}
          </span>
        </div>
      }
    />
  );
}

export function CodexIsolationSetting({
  environmentId,
  isolated,
  readOnly = false,
  restartRequired = false,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly isolated: boolean;
  readonly readOnly?: boolean;
  readonly restartRequired?: boolean;
  readonly onChange: (isolated: boolean) => void;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const locks = managedInstanceLocks(
    useManagedPolicy(environmentId),
    ProviderDriverKind.make("codex"),
  );
  const reason = locks?.configKeys.has("isolateRuntime") ? locks.reason : undefined;
  return (
    <SettingsRow
      title={<label htmlFor={id}>Separate Codex installation</label>}
      description={
        <span id={descriptionId}>
          Use an official OpenAI download with separate settings and conversations.
          {restartRequired
            ? " Restart the T3 Code server after changing this for an active provider."
            : ""}
        </span>
      }
      control={
        <ManagedControl reason={reason}>
          <Switch
            id={id}
            aria-describedby={descriptionId}
            aria-label="Separate Codex installation"
            checked={isolated}
            disabled={readOnly || !canManage}
            onCheckedChange={onChange}
          />
        </ManagedControl>
      }
    />
  );
}
