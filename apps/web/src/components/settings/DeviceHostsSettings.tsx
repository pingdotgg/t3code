import { DeviceToolVersions } from "../device/DeviceToolVersions";
import { DeviceHostAvailability } from "../device/DeviceHostAvailability";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { AppleIcon, AndroidIcon } from "../Icons";
import { Spinner } from "../ui/spinner";
import type { EnvironmentId, SshDeviceHostConfig } from "@t3tools/contracts";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { deviceEnvironment } from "../../state/device";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleIcon,
  MoreVertical,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { SettingsRow } from "./settingsLayout";

import { useSettingsScope } from "./SettingsScopeContext";
import { toastManager } from "../ui/toast";
import {
  groupDeviceHosts,
  updateDeviceHosts,
  type DeviceHostEnvironment,
  type DeviceHostGroup,
} from "./deviceHostsSettings.logic";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { DeviceHostEditor } from "./DeviceHostEditor";
import { useHostConnectionChecks } from "./useHostConnectionChecks";
import { deviceHostConnectionKey } from "./deviceHostConnectionChecks";
import { settingsScopeEnvironmentLabel, settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import { DeviceHostDiagnostics } from "../device/DeviceSetup";

export function DeviceHostsSettings(props: { environmentId: EnvironmentId | null }) {
  const { scope, environments, connectedEnvironments } = useSettingsScope();
  const canConfigure = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [editing, setEditing] = useState<SshDeviceHostConfig | null>(null);
  const [originalHost, setOriginalHost] = useState<SshDeviceHostConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: settingsScopeEnvironmentLabel(environment, environments),
    connected: environment.connection.phase === "connected",
  }));
  const { checks, testConnection } = useHostConnectionChecks(targets);
  const hostEnvironments = connectedEnvironments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    labels: settingsScopeEnvironmentLabels(environment, connectedEnvironments),
    hosts: environment.serverConfig?.settings.deviceHosts ?? [],
  }));
  const groupedHosts = groupDeviceHosts(hostEnvironments);
  const save = async (host: SshDeviceHostConfig, remove = false, original = host) => {
    if (!props.environmentId || projectScope) return;
    setBusy(true);
    const results = await Promise.allSettled(
      environments.map(async (environment) => {
        if (environment.connection.phase !== "connected" || !environment.serverConfig) {
          throw new Error("Environment disconnected");
        }
        if (!readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope)) {
          throw new Error("This connection cannot change device settings.");
        }
        return update({
          environmentId: environment.environmentId,
          input: {
            patch: {
              deviceHosts: updateDeviceHosts(
                environment.serverConfig.settings.deviceHosts,
                host,
                remove,
                original,
              ),
            },
          },
        });
      }),
    );
    setBusy(false);
    const failed = environments.filter((_, index) => {
      const result = results[index];
      return result?.status !== "fulfilled" || result.value._tag === "Failure";
    });
    if (failed.length === 0) {
      setEditing(null);
    } else {
      toastManager.add({
        type: "error",
        title: "Device hosts not saved on all environments",
        description: `Could not update ${failed.map((environment) => environment.label).join(", ")}.`,
      });
    }
  };
  const listActions = {
    busy: !canConfigure || projectScope || busy,
    checks,
    testConnection: async (host: SshDeviceHostConfig) => {
      const results = await testConnection(host);
      if (!results) return;
      const failed = targets.filter((target) => results[target.environmentId]?.status === "failed");
      toastManager.add({
        type: failed.length ? "error" : "success",
        title: failed.length
          ? `${host.label}: ${failed.length} of ${targets.length} environments failed`
          : `${host.label}: connection checks passed`,
        description: failed.length
          ? `Could not connect from ${failed.map((target) => target.label).join(", ")}.`
          : "Connected or already available locally on each selected environment.",
      });
      return results;
    },
    onEdit: (host: SshDeviceHostConfig) => {
      setOriginalHost(host);
      setEditing(host);
    },
    onRemove: (host: SshDeviceHostConfig) => void save(host, true),
  };
  return (
    <SettingsRow
      id="device-hosts"
      title="Device hosts"
      serverScoped
      settingKeys={["deviceHosts"]}
      description="Add remote machines with simulator or emulator runtimes installed, and the selected environments will connect over SSH and set up device tools automatically."
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={
            !canConfigure || projectScope || busy || !props.environmentId || editing !== null
          }
          onClick={() => {
            setOriginalHost(null);
            setEditing({ id: randomUUID(), label: "", target: "" });
          }}
        >
          <PlusIcon className="size-3.5" /> Add host
        </Button>
      }
    >
      <div className="pt-3 pb-2">
        {!props.environmentId ? (
          <p className="text-sm text-muted-foreground">
            Connect a selected environment to manage device hosts.
          </p>
        ) : (
          <>
            {hostEnvironments.length > 1 && groupedHosts === null ? (
              <div className="space-y-2">
                {hostEnvironments.map((environment) => (
                  <FoldedSettingsSection
                    key={environment.environmentId}
                    id={`device-hosts-${environment.environmentId}`}
                    title={
                      <>
                        <span className="block max-w-64 truncate">
                          {environment.labels.primary}
                        </span>
                        {environment.labels.secondary ? (
                          <span className="block max-w-64 truncate text-xs font-normal text-muted-foreground">
                            {environment.labels.secondary}
                          </span>
                        ) : null}
                      </>
                    }
                    summary={
                      summarizeLabels(environment.hosts.map((host) => host.label)) ||
                      "No device hosts"
                    }
                  >
                    <div className="px-3 sm:px-4 [&>div:first-child]:border-t-0">
                      <DeviceHostList environments={[environment]} {...listActions} />
                    </div>
                  </FoldedSettingsSection>
                ))}
              </div>
            ) : (
              <DeviceHostList
                environments={hostEnvironments}
                groups={groupedHosts ?? undefined}
                compact={hostEnvironments.length > 1}
                {...listActions}
              />
            )}
            {editing ? (
              <DeviceHostEditor
                key={editing.id}
                host={editing}
                isNew={originalHost === null}
                targets={targets}
                busy={busy}
                onSave={(host) => void save(host, false, originalHost ?? host)}
                onClose={() => setEditing(null)}
              />
            ) : null}
          </>
        )}
      </div>
    </SettingsRow>
  );
}

const deviceHostStatesAtom = environmentAtomList("web-device-host-states", (environmentId) =>
  deviceEnvironment.state({ environmentId, input: {} }),
);

function DeviceHostList({
  environments,
  groups,
  compact = false,
  busy,
  onEdit,
  onRemove,
  checks,
  testConnection,
}: {
  environments: ReadonlyArray<DeviceHostEnvironment>;
  groups?: ReadonlyArray<DeviceHostGroup> | undefined;
  compact?: boolean;
  busy: boolean;
  onEdit: (host: SshDeviceHostConfig) => void;
  onRemove: (host: SshDeviceHostConfig) => void;
  checks: ReturnType<typeof useHostConnectionChecks>["checks"];
  testConnection: ReturnType<typeof useHostConnectionChecks>["testConnection"];
}) {
  const { environments: scopeEnvironments } = useSettingsScope();
  const environmentLabels = new Map(
    scopeEnvironments.map((environment) => [
      environment.environmentId,
      settingsScopeEnvironmentLabels(environment, scopeEnvironments),
    ]),
  );
  const environmentIds = environments.map(({ environmentId }) => environmentId);
  const results = useAtomValue(deviceHostStatesAtom(environmentIdsKey(environmentIds)));
  const states = new Map(
    environmentIds.map(
      (environmentId, index) =>
        [environmentId, Option.getOrUndefined(AsyncResult.value(results[index]!))] as const,
    ),
  );
  const retry = useAtomCommand(deviceEnvironment.list);
  const [retrying, setRetrying] = useState<string | null>(null);
  const retryHost = (environmentId: EnvironmentId, hostId: string, key = hostId) => {
    setRetrying(key);
    void retry({ environmentId, input: { retryHostId: hostId } }).finally(() => setRetrying(null));
  };
  const rows =
    groups ??
    environments.flatMap((environment) =>
      environment.hosts.map((host) => ({
        host,
        members: [{ environmentId: environment.environmentId, label: environment.label, host }],
      })),
    );
  return (
    <>
      {rows.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No device hosts.</p>
      ) : null}
      {rows.map(({ host, members }) => {
        const hostChecks = checks[deviceHostConnectionKey(host)];
        const checkedMembers = scopeEnvironments.flatMap((environment) =>
          hostChecks?.[environment.environmentId] &&
          !members.some((member) => member.environmentId === environment.environmentId)
            ? [{ environmentId: environment.environmentId, label: environment.label, host }]
            : [],
        );
        const results = [...members, ...checkedMembers].map((member) => {
          const state = states.get(member.environmentId);
          const status = state?.hostStatuses[member.host.id];
          const check = hostChecks?.[member.environmentId];
          const summary = state?.hosts.find((value) => value.id === member.host.id);
          const label = environmentLabels.get(member.environmentId)?.primary ?? member.label;
          const address = environmentLabels.get(member.environmentId)?.secondary;
          const error =
            check?.status === "failed"
              ? check.error
              : check?.status === "local"
                ? undefined
                : status?.status === "failed"
                  ? status.detail
                  : undefined;
          return {
            ...member,
            label,
            address,
            name: [label, address].filter(Boolean).join(" · "),
            state,
            status,
            check,
            summary,
            error,
            versions: (
              <DeviceToolVersions
                owner={label}
                error={summary?.toolInspectionError}
                tools={summary?.tools ?? (check?.status === "connected" ? check.tools : undefined)}
              />
            ),
          };
        });
        const first = results[0];
        if (!first) return null;
        const { environmentId, status, check, summary, error } = first;
        const platforms =
          (check?.status === "connected" ? check.platforms : undefined) ?? summary?.platforms ?? [];
        const progress =
          check?.status === "pending"
            ? "Checking connection…"
            : status?.status === "installing"
              ? "Installing device support…"
              : status?.status === "starting"
                ? "Connecting…"
                : null;
        const failed = results.filter(
          (result) =>
            result.check?.status === "failed" ||
            (result.check?.status !== "local" && result.status?.status === "failed"),
        );
        const pending = results.some(
          (result) =>
            result.check?.status === "pending" ||
            result.status?.status === "installing" ||
            result.status?.status === "starting",
        );
        const ready = results.every(
          (result) =>
            result.check?.status === "connected" ||
            result.check?.status === "local" ||
            result.status?.status === "ready",
        );
        const retryable = results.filter(
          (result) =>
            result.status?.status === "failed" &&
            result.state?.supportsHostRetry &&
            result.state.hostStatus !== "disabled",
        );
        const canRetry = !compact && retryable.includes(first);
        const indicators = compact
          ? [
              {
                key: "connection",
                label: failed.length
                  ? "Connection failed"
                  : pending
                    ? "Checking connections"
                    : ready
                      ? "Connected"
                      : "Connection not checked",
                warning: failed.length > 0,
                icon: failed.length ? (
                  <TriangleAlertIcon className="size-3.5" />
                ) : pending ? (
                  <Spinner size="xs" />
                ) : ready ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <CircleIcon className="size-3.5" />
                ),
                detail: failed.length ? (
                  <div className="space-y-1">
                    {failed.map((result) => (
                      <p key={result.environmentId}>
                        {result.name}: {result.error || "Connection failed"}
                      </p>
                    ))}
                  </div>
                ) : pending ? (
                  "Checking connections…"
                ) : ready ? (
                  "Connected or available locally on each listed machine"
                ) : (
                  "Test the connection to check access from each machine"
                ),
              },
            ]
          : platforms
              .filter((platform) => platform.available)
              .map((platform) => ({
                key: platform.platform,
                label: platform.platform === "ios" ? "iOS available" : "Android available",
                warning: false,
                icon:
                  platform.platform === "ios" ? (
                    // The Apple mark is bottom-heavy; lift it so it does not dip under the label.
                    <AppleIcon className="size-3.5 -translate-y-px" />
                  ) : (
                    <AndroidIcon className="size-3.5" />
                  ),
              }));
        return (
          <div key={host.id} className="flex items-center gap-2 border-t border-border/50 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm font-medium">{host.label}</p>
                {indicators.map((indicator) => (
                  <Tooltip key={indicator.key}>
                    <TooltipTrigger
                      render={
                        <span
                          tabIndex={0}
                          role="img"
                          aria-label={indicator.label}
                          className={
                            indicator.warning
                              ? "shrink-0 text-warning"
                              : "shrink-0 text-muted-foreground"
                          }
                        />
                      }
                    >
                      {indicator.icon}
                    </TooltipTrigger>
                    <TooltipPopup>
                      {"detail" in indicator ? indicator.detail : indicator.label}
                    </TooltipPopup>
                  </Tooltip>
                ))}
              </div>
              <p className="truncate text-xs text-muted-foreground">{host.target}</p>
              {results
                .filter(
                  (result) =>
                    result.status?.status === "ready" && result.status.androidDiscoveryIncomplete,
                )
                .map((result) => (
                  <p key={result.environmentId} role="status" className="mt-1 text-xs text-warning">
                    {compact ? `${result.label}: ` : ""}
                    {result.status?.detail ??
                      "The Android device list may be incomplete. Refresh devices to try again."}
                  </p>
                ))}
              {compact ? (
                <Collapsible>
                  <div className="min-w-0 text-xs [--inline-button-white-space:normal]">
                    <CollapsibleTrigger
                      aria-label={`${host.label} machine details`}
                      render={<InlineButton tone="muted" />}
                    >
                      <span className="line-clamp-1 break-all text-left">
                        {summarizeLabels(results.map((result) => result.name))}
                      </span>
                      <ChevronDownIcon className="size-3 shrink-0" />
                    </CollapsibleTrigger>
                  </div>
                  <CollapsiblePanel>
                    <div className="mt-2 space-y-2">
                      {results.map((result) => (
                        <div key={result.environmentId}>
                          <p className="text-xs text-muted-foreground">{result.label}</p>
                          {result.address ? (
                            <p className="truncate text-xs text-muted-foreground">
                              {result.address}
                            </p>
                          ) : null}
                          {result.error ? (
                            <p role="status" className="text-xs text-destructive">
                              {result.error}
                            </p>
                          ) : null}
                          {result.state ? (
                            <DeviceHostDiagnostics
                              hosts={[result.host]}
                              hostStatuses={result.state.hostStatuses}
                            />
                          ) : null}
                          {result.versions}
                          {result.check?.status === "local" ? (
                            <p className="text-xs text-muted-foreground">
                              Already available locally
                            </p>
                          ) : (
                            <DeviceHostAvailability
                              platforms={
                                (result.check?.status === "connected"
                                  ? result.check.platforms
                                  : result.summary?.platforms) ?? []
                              }
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              ) : (
                first.versions
              )}
              {!compact && check?.status === "local" ? (
                <p className="mt-1 text-xs text-muted-foreground">Already available locally</p>
              ) : null}
              {!compact && error ? (
                <div className="mt-1" role="status">
                  <details className="text-xs text-destructive">
                    <summary>Connection failed</summary>
                    <p className="mt-1 whitespace-pre-wrap break-words">{error}</p>
                  </details>
                </div>
              ) : null}
              {!compact
                ? results.map((result) =>
                    result.state ? (
                      <DeviceHostDiagnostics
                        key={result.environmentId}
                        className="mt-1"
                        hosts={[result.host]}
                        hostStatuses={result.state.hostStatuses}
                      />
                    ) : null,
                  )
                : null}
            </div>
            {!compact && progress ? (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Spinner size="xs" />
                {progress}
              </span>
            ) : null}
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    disabled={busy}
                    aria-label={host.label + " options"}
                  />
                }
              >
                <MoreVertical />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => onEdit(host)}>Edit</MenuItem>
                <MenuItem variant="destructive" onClick={() => onRemove(host)}>
                  Remove
                </MenuItem>
                {compact
                  ? retryable.map((result) => (
                      <MenuItem
                        key={result.environmentId}
                        disabled={retrying !== null}
                        onClick={() =>
                          retryHost(result.environmentId, result.host.id, result.environmentId)
                        }
                      >
                        {retrying === result.environmentId ? "Retrying" : "Retry"} from{" "}
                        {result.label}
                        {result.address ? ` (${result.address})` : null}
                      </MenuItem>
                    ))
                  : null}
              </MenuPopup>
            </Menu>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy || (canRetry ? retrying !== null : compact ? pending : progress !== null)
              }
              onClick={() => {
                if (canRetry) retryHost(environmentId, host.id);
                else void testConnection(host);
              }}
            >
              {canRetry ? (retrying === host.id ? "Retrying…" : "Retry") : "Test connection"}
            </Button>
          </div>
        );
      })}
    </>
  );
}

function summarizeLabels(labels: ReadonlyArray<string>) {
  return `${labels.slice(0, 2).join(", ")}${labels.length > 2 ? ` +${labels.length - 2}` : ""}`;
}
