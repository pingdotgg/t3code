import { useT } from "../../hooks/useI18n";
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
import { useRef, useState } from "react";
import { Trash2Icon } from "lucide-react";

import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";

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
  const t = useT();
  return (
    <section
      aria-label={t("settings.providers.setup.antigravity")}
      className="@container/setup divide-y divide-border/50 text-xs [&_[data-slot=settings-row]]:rounded-none"
    >
      <SettingsRow
        className="@max-lg/setup:[&>div:first-child]:flex @max-lg/setup:[&>div:first-child]:items-stretch @max-lg/setup:[&>div:first-child]:gap-3"
        title={t("settings.providers.setup.environment")}
        description={t("settings.providers.setup.device")}
        control={
          <div className="flex min-w-0 flex-col gap-2 sm:items-end">
            <span className="text-muted-foreground [overflow-wrap:anywhere]">
              {props.environmentLabel}
            </span>
            {!props.enabled && !props.readOnly ? (
              <Button size="sm" variant="outline" onClick={props.onEnable}>
                {t("settings.providers.setup.enable")}
              </Button>
            ) : null}
          </div>
        }
      />
      {props.readOnly ? (
        <SettingsRow
          title={t("settings.providers.setup.unavailable")}
          description={t("settings.providers.setup.readOnly")}
        />
      ) : props.provider?.setup === undefined ? (
        <SettingsRow
          title={t("settings.providers.setup.updateRequired")}
          description={t("settings.providers.setup.updateEnvironment")}
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
  const t = useT();
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const installQuery = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
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
      ? t("settings.providers.setup.checking")
      : installation?.phase === "downloading"
        ? t("settings.providers.setup.downloading", {
            progress: String((installation.downloadedBytes / 1_000_000).toFixed(1)),
            total: String(
              installation.totalBytes === null
                ? ""
                : ` of ${(installation.totalBytes / 1_000_000).toFixed(1)} MB`,
            ),
          })
        : installation?.phase === "extracting"
          ? t("settings.providers.setup.extracting")
          : installation?.phase === "verifying"
            ? t("settings.providers.setup.verifying")
            : installed
              ? t("settings.providers.setup.installed")
              : usesCustomBinary
                ? enabled
                  ? t("settings.providers.setup.unavailableRuntime")
                  : t("settings.providers.setup.uncheckedRuntime")
                : installation?.totalBytes
                  ? t("settings.providers.setup.downloadSize", {
                      size: String(Math.ceil(installation.totalBytes / 1_000_000)),
                    })
                  : t("settings.providers.setup.notInstalled");

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
      setError(t("settings.providers.setup.failed"));
      return false;
    }
    const result = settled.value;
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : t("settings.providers.setup.failedShort"),
        );
      }
      return false;
    }
    return true;
  }

  async function removeRuntime() {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      t("settings.providers.setup.removeConfirm", { environment: String(environmentLabel) }),
    );
    if (confirmed) {
      await runCommand(t("settings.providers.setup.removing"), () => removeInstall(target));
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
        title={t("settings.providers.setup.runtime")}
        className="@max-lg/setup:[&>div:first-child]:flex @max-lg/setup:[&>div:first-child]:items-stretch @max-lg/setup:[&>div:first-child]:gap-3"
        description={t("settings.providers.setup.manage")}
        status={
          <div className="space-y-2">
            {usesCustomBinary ? (
              <p className="text-muted-foreground">{t("settings.providers.setup.customBinary")}</p>
            ) : null}
            {!installed && !provider.setup?.canInstall ? (
              <p className="text-muted-foreground">
                {t("settings.providers.setup.automaticUnavailable")}
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
                  aria-label={t("settings.providers.setup.downloadA11y")}
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
                    variant="outline"
                    disabled={actionsDisabled}
                    onClick={() => {
                      const operationId = installation.operationId;
                      if (!operationId) return;
                      void runCommand(t("settings.providers.setup.cancelling"), () =>
                        cancelInstall({ environmentId, input: { instanceId, operationId } }),
                      );
                    }}
                  >
                    {t("settings.providers.setup.cancel")}
                  </Button>
                ) : !installActive && provider.setup?.canInstall ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={actionsDisabled || authActive}
                    onClick={() =>
                      void runCommand(t("settings.providers.setup.starting"), () =>
                        startInstall(target),
                      )
                    }
                  >
                    {installation?.installedVersion
                      ? installation.version &&
                        installation.version !== installation.installedVersion
                        ? t("settings.providers.setup.update")
                        : t("settings.providers.setup.reinstall")
                      : installation?.phase === "failed" || installation?.phase === "cancelled"
                        ? t("settings.providers.setup.retry")
                        : installed
                          ? t("settings.providers.setup.installManaged")
                          : t("settings.providers.setup.install")}
                  </Button>
                ) : null}
              </div>
              {installation?.canRemove && !installActive ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="col-start-1 row-start-1"
                        aria-label={t("settings.providers.setup.remove")}
                        disabled={actionsDisabled || authActive}
                        onClick={() => void removeRuntime()}
                      />
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup>{t("settings.providers.setup.remove")}</TooltipPopup>
                </Tooltip>
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
              variant="outline"
              className="w-fit"
              onClick={() => {
                authQuery.refresh();
                installQuery.refresh();
              }}
            >
              {t("settings.providers.setup.retryStatus")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
