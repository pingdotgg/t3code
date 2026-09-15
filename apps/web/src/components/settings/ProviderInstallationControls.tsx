import type { ProviderInstallState } from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";

/** Shared runtime controls for both the pinned ACP runtime and official CLI releases. */
export function ProviderInstallationControls({
  providerName,
  installation,
  installed,
  usesCustomBinary,
  canInstall,
  disabled,
  installationStatusMessage,
  onInstall,
  onCancel,
  onRemove,
  tracksReleases = false,
  compact = false,
}: {
  readonly providerName: string;
  readonly installation: ProviderInstallState | null;
  readonly installed: boolean;
  readonly usesCustomBinary: boolean;
  readonly canInstall: boolean;
  readonly disabled: boolean;
  readonly installationStatusMessage: string;
  readonly onInstall: () => void;
  readonly onCancel: (operationId: string) => void;
  readonly onRemove: () => void;
  readonly tracksReleases?: boolean;
  readonly compact?: boolean;
}) {
  const installActive =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const control = (
    <div
      className={
        compact
          ? "flex w-full min-w-0 flex-col gap-2"
          : "flex w-full min-w-0 flex-col gap-2 sm:w-56 sm:text-right"
      }
    >
      <p role="status" className="min-h-4 text-muted-foreground tabular-nums">
        {installationStatusMessage}
      </p>
      <div className="h-1">
        {installation?.phase === "downloading" &&
        installation.totalBytes !== null &&
        installation.totalBytes > 0 ? (
          <progress
            aria-label={`${providerName} download`}
            className="block h-1 w-full accent-foreground"
            value={installation.downloadedBytes}
            max={installation.totalBytes}
          />
        ) : null}
      </div>
      {!installActive &&
      installation?.message &&
      installation.message !== installationStatusMessage ? (
        <p className="text-muted-foreground [overflow-wrap:anywhere]">{installation.message}</p>
      ) : null}
      <div className="grid min-h-7 grid-cols-[1.75rem_minmax(0,1fr)] gap-2">
        <div className="col-start-2 row-start-1 grid">
          {installActive && installation.operationId ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                const operationId = installation.operationId;
                if (!operationId) return;
                onCancel(operationId);
              }}
            >
              Cancel installation
            </Button>
          ) : !installActive && canInstall ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || installation === null}
              onClick={onInstall}
            >
              {installation?.installedVersion
                ? tracksReleases ||
                  (installation.version && installation.version !== installation.installedVersion)
                  ? `Update ${providerName}`
                  : `Reinstall ${providerName}`
                : installation?.phase === "failed" || installation?.phase === "cancelled"
                  ? "Retry installation"
                  : installed
                    ? "Install managed runtime"
                    : `Install ${providerName}`}
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
                  aria-label="Remove downloaded runtime"
                  disabled={disabled}
                  onClick={onRemove}
                />
              }
            >
              <Trash2Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>Remove downloaded runtime</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
  if (compact) return control;
  return (
    <SettingsRow
      title="Runtime"
      className="@max-lg/setup:[&>div:first-child]:flex @max-lg/setup:[&>div:first-child]:items-stretch @max-lg/setup:[&>div:first-child]:gap-3"
      description={`Install and manage ${providerName}.`}
      status={
        <div className="space-y-2">
          {usesCustomBinary ? (
            <p className="text-muted-foreground">
              Uses the custom binary path below. Installation keeps that path.
            </p>
          ) : null}
          {!installed && !canInstall ? (
            <p className="text-muted-foreground">
              Automatic installation unavailable. Set a binary path or use another environment.
            </p>
          ) : null}
        </div>
      }
      control={control}
    />
  );
}
