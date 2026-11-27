import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  ANTIGRAVITY_AUTH_METHODS,
  type AntigravityAuthMethod,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useRef, useState } from "react";
import { Trash2Icon } from "lucide-react";

import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

interface ProviderSetupSectionProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly binaryPath?: string | undefined;
  readonly authMethod?: AntigravityAuthMethod | undefined;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => void;
}

export function readAntigravityAuthMethod(config: unknown): AntigravityAuthMethod {
  const value =
    config !== null && typeof config === "object" && "authMethod" in config
      ? config.authMethod
      : undefined;
  return (
    ANTIGRAVITY_AUTH_METHODS.find((method) => method.value === value)?.value ?? "oauth-personal"
  );
}

export function ProviderSetupSection(props: ProviderSetupSectionProps) {
  const gt = useGT();
  return (
    <section
      aria-label={gt("Antigravity setup")}
      className="@container/setup divide-y divide-border/50 text-xs [&_[data-slot=settings-row]]:rounded-none"
    >
      <SettingsRow
        className="@max-lg/setup:[&>div:first-child]:flex @max-lg/setup:[&>div:first-child]:items-stretch @max-lg/setup:[&>div:first-child]:gap-3"
        title={gt("Environment")}
        description={gt("Device that runs this provider.")}
        control={
          <div className="flex min-w-0 flex-col gap-2 sm:items-end">
            <span className="text-muted-foreground [overflow-wrap:anywhere]">
              {props.environmentLabel}
            </span>
            {!props.enabled && !props.readOnly ? (
              <Button size="sm" variant="secondary" onClick={props.onEnable}>
                <T>Enable Antigravity</T>
              </Button>
            ) : null}
          </div>
        }
      />
      {props.readOnly ? (
        <SettingsRow
          title={gt("Setup unavailable")}
          description={gt("Provider setup is read-only.")}
        />
      ) : props.provider?.setup === undefined ? (
        <SettingsRow
          title={gt("Update required")}
          description={gt("Update this environment to manage Antigravity.")}
        />
      ) : (
        <ProviderSetupActions
          key={`${props.environmentId}:${props.instanceId}`}
          environmentId={props.environmentId}
          environmentLabel={props.environmentLabel}
          instanceId={props.instanceId}
          provider={props.provider}
          binaryPath={props.binaryPath}
          authMethod={props.authMethod ?? "oauth-personal"}
          enabled={props.enabled}
        />
      )}
    </section>
  );
}

function ProviderSetupActions({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  enabled,
  binaryPath,
}: Pick<
  ProviderSetupSectionProps,
  "environmentId" | "environmentLabel" | "instanceId" | "enabled" | "binaryPath"
> & {
  readonly provider: ServerProvider;
  readonly authMethod: AntigravityAuthMethod;
}) {
  const gt = useGT();
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target), useMessages());
  const installQuery = useEnvironmentQuery(
    serverEnvironment.providerInstallState(target),
    useMessages(),
  );
  const auth = authQuery.data;
  const installation = installQuery.data;
  const commandOptions = { reportFailure: false, reportDefect: false };
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, commandOptions);
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, commandOptions);
  const removeInstall = useAtomCommand(
    serverEnvironment.removeProviderInstallation,
    commandOptions,
  );
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const authActive =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const installActive =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const usesCustomBinary = Boolean(binaryPath?.trim());
  const installed =
    provider.installed || (!usesCustomBinary && installation?.installedVersion != null);
  const queryError = authQuery.error ?? installQuery.error;
  const actionsDisabled = pendingLabel !== null || queryError !== null;
  const installationStatusMessage =
    installation === null
      ? gt("Checking the Antigravity runtime.")
      : installation?.phase === "downloading"
        ? installation.totalBytes === null
          ? gt("Downloading {downloaded} MB.", {
              downloaded: (installation.downloadedBytes / 1_000_000).toFixed(1),
            })
          : gt("Downloading {downloaded} MB of {total} MB.", {
              downloaded: (installation.downloadedBytes / 1_000_000).toFixed(1),
              total: (installation.totalBytes / 1_000_000).toFixed(1),
            })
        : installation?.phase === "extracting"
          ? gt("Extracting Antigravity.")
          : installation?.phase === "verifying"
            ? gt("Checking the downloaded runtime.")
            : installed
              ? gt("Installed.")
              : usesCustomBinary
                ? enabled
                  ? gt("The configured Antigravity runtime is unavailable.")
                  : gt("The configured Antigravity runtime has not been checked.")
                : installation?.totalBytes
                  ? gt("{size} MB download.", {
                      size: Math.ceil(installation.totalBytes / 1_000_000),
                    })
                  : gt("Not installed.");

  async function runCommand<A, E>(
    label: string,
    request: () => Promise<AtomCommandResult<A, E>>,
  ): Promise<boolean> {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPendingLabel(label);
    setError(null);
    const settled = await settlePromise(request);
    pendingRef.current = false;
    setPendingLabel(null);
    if (settled._tag === "Failure") {
      setError(gt("Provider setup failed. Try again."));
      return false;
    }
    const result = settled.value;
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? (thrownErrorMessage(failure, m) ?? failure.message)
            : gt("Provider setup failed."),
        );
      }
      return false;
    }
    return true;
  }

  async function removeRuntime() {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      gt(
        "Remove the downloaded Antigravity runtime from {environment}? Google sign-in and thread history are kept.",
        { environment: environmentLabel },
      ),
    );
    if (confirmed) {
      await runCommand(gt("Removing runtime"), () => removeInstall(target));
    }
  }

  return (
    <div className="divide-y divide-border/50">
      {/* Keep the live region first so sibling divider rules do not add a divider after the last visible
       * row. */}
      <p className="sr-only" role="status">
        {pendingLabel ? `${pendingLabel}.` : null}
      </p>
      <SettingsRow
        title={gt("Runtime")}
        className="@max-lg/setup:[&>div:first-child]:flex @max-lg/setup:[&>div:first-child]:items-stretch @max-lg/setup:[&>div:first-child]:gap-3"
        description={gt("Install and manage Antigravity.")}
        status={
          <div className="space-y-2">
            {usesCustomBinary ? (
              <p className="text-muted-foreground">
                <T>Uses the custom binary path below. Installation keeps that path.</T>
              </p>
            ) : null}
            {!installed && !provider.setup?.canInstall ? (
              <p className="text-muted-foreground">
                <T>
                  Automatic installation unavailable. Set a binary path or use another environment.
                </T>
              </p>
            ) : null}
          </div>
        }
        control={
          <div className="flex w-full min-w-0 flex-col gap-2 @min-[32rem]/settings-row:w-56 @min-[32rem]/settings-row:text-right">
            <p role="status" className="min-h-4 text-muted-foreground tabular-nums">
              {installationStatusMessage}
            </p>
            <div className="h-1">
              {installation?.phase === "downloading" &&
              installation.totalBytes !== null &&
              installation.totalBytes > 0 ? (
                <progress
                  aria-label={gt("Antigravity download")}
                  // Forced-colors mode repaints the track and fill as Canvas, and
                  // appearance:auto cannot bring the native widget back: the
                  // preflight border reset marks every <progress> as author-styled,
                  // so Chromium keeps its fallback paint. Use system colors instead.
                  className="block h-1 w-full appearance-none overflow-hidden rounded-full bg-muted forced-colors:border [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary forced-colors:[&::-moz-progress-bar]:bg-[Highlight] [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary forced-colors:[&::-webkit-progress-value]:bg-[Highlight]"
                  value={installation.downloadedBytes}
                  max={installation.totalBytes}
                />
              ) : null}
            </div>
            {!installActive &&
            installation?.message &&
            installation.message !== installationStatusMessage ? (
              <p className="text-muted-foreground [overflow-wrap:anywhere]">
                {installation.message}
              </p>
            ) : null}
            <div className="grid min-h-7 grid-cols-[1.75rem_minmax(0,1fr)] gap-2">
              <div className="col-start-2 row-start-1 grid">
                {installActive && installation.operationId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={actionsDisabled}
                    onClick={() => {
                      const operationId = installation.operationId;
                      if (!operationId) return;
                      void runCommand(gt("Cancelling installation"), () =>
                        cancelInstall({ environmentId, input: { instanceId, operationId } }),
                      );
                    }}
                  >
                    <T>Cancel installation</T>
                  </Button>
                ) : !installActive && provider.setup?.canInstall ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={actionsDisabled || authActive}
                    onClick={() =>
                      void runCommand(gt("Starting installation"), () => startInstall(target))
                    }
                  >
                    {installation?.installedVersion
                      ? installation.version &&
                        installation.version !== installation.installedVersion
                        ? gt("Update Antigravity")
                        : gt("Reinstall Antigravity")
                      : installation?.phase === "failed" || installation?.phase === "cancelled"
                        ? gt("Retry installation")
                        : installed
                          ? gt("Install managed runtime")
                          : gt("Install Antigravity")}
                  </Button>
                ) : null}
              </div>
              {installation?.canRemove && !installActive ? (
                <SharedTooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="col-start-1 row-start-1"
                      aria-label={gt("Remove downloaded runtime")}
                      disabled={actionsDisabled || authActive}
                      onClick={() => void removeRuntime()}
                    />
                  }
                  label={
                    <>
                      <T>Remove downloaded runtime</T>
                    </>
                  }
                >
                  <Trash2Icon className="size-3.5" />
                </SharedTooltipTrigger>
              ) : null}
            </div>
          </div>
        }
      />

      <ProviderAuthenticationSection
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        instanceId={instanceId}
        provider={provider}
        readOnly={false}
      />

      {error || queryError ? (
        <div className="grid gap-2 px-3 py-3 sm:px-4">
          <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
            {error ?? queryError}
          </p>
          {queryError ? (
            <Button
              size="sm"
              variant="secondary"
              className="w-fit"
              onClick={() => {
                authQuery.refresh();
                installQuery.refresh();
              }}
            >
              <T>Retry setup status</T>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
