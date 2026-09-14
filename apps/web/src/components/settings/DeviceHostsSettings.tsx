import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { AppleIcon, AndroidIcon } from "../Icons";
import { DeviceHostAvailability } from "../device/DeviceHostAvailability";
import { Spinner } from "../ui/spinner";
import type {
  DevicePlatformAvailability,
  EnvironmentId,
  SshDeviceHostConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { deviceEnvironment, useDeviceState } from "../../state/device";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MoreVertical, PlusIcon } from "lucide-react";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { SettingsRow } from "./settingsLayout";

import { useSettingsScope } from "./SettingsScopeContext";
import { toastManager } from "../ui/toast";
import { updateDeviceHosts } from "./deviceHostsSettings.logic";

export function DeviceHostsSettings(props: { environmentId: EnvironmentId | null }) {
  const { scope, environments, connectedEnvironments, environment: selected } = useSettingsScope();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [editing, setEditing] = useState<SshDeviceHostConfig | null>(null);
  const [originalHost, setOriginalHost] = useState<SshDeviceHostConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const validPort = (port: number | undefined) =>
    port === undefined || (Number.isInteger(port) && port >= 1 && port <= 65535);
  const { checks, testConnection } = useHostConnectionChecks(props.environmentId);
  const save = async (host: SshDeviceHostConfig, remove = false, original = host) => {
    if (!props.environmentId || projectScope) return;
    setBusy(true);
    try {
      const results = await Promise.allSettled(
        environments.map(async (environment) => {
          if (environment.connection.phase !== "connected" || !environment.serverConfig) {
            throw new Error("Environment disconnected");
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
    } finally {
      setBusy(false);
    }
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
          disabled={projectScope || busy || !props.environmentId || editing !== null}
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
            {connectedEnvironments.map((environment) => (
              <div key={environment.environmentId}>
                {connectedEnvironments.length > 1 ? (
                  <p className="pt-3 pb-1 text-xs font-medium text-muted-foreground">
                    {environment.label}
                  </p>
                ) : null}
                <DeviceHostList
                  environmentId={environment.environmentId}
                  hosts={environment.serverConfig?.settings.deviceHosts ?? []}
                  busy={projectScope || busy}
                  onEdit={(host) => {
                    setOriginalHost(host);
                    setEditing(host);
                  }}
                  onRemove={(host) => void save(host, true)}
                />
              </div>
            ))}
            {editing ? (
              <form
                className="space-y-3 border-t border-border/50 py-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(editing, false, originalHost ?? editing);
                }}
              >
                <label className="block space-y-1 text-sm">
                  <span>Name</span>
                  <Input
                    required
                    value={editing.label}
                    disabled={projectScope || busy}
                    onChange={(event) => setEditing({ ...editing, label: event.target.value })}
                    placeholder="Mac mini"
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>SSH target</span>
                  <Input
                    required
                    value={editing.target}
                    disabled={projectScope || busy}
                    onChange={(event) => setEditing({ ...editing, target: event.target.value })}
                    placeholder="user@host or SSH alias"
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Identity file, optional</span>
                  <Input
                    value={editing.identityFile ?? ""}
                    disabled={projectScope || busy}
                    onChange={(event) => {
                      const { identityFile: _, ...rest } = editing;
                      setEditing(
                        event.target.value ? { ...rest, identityFile: event.target.value } : rest,
                      );
                    }}
                    placeholder="~/.ssh/id_ed25519"
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Port, optional</span>
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={editing.port ?? ""}
                    disabled={projectScope || busy}
                    onChange={(event) => {
                      const { port: _, ...rest } = editing;
                      setEditing(
                        event.target.value ? { ...rest, port: Number(event.target.value) } : rest,
                      );
                    }}
                    placeholder="SSH config default"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    type="submit"
                    disabled={
                      busy ||
                      !editing.label.trim() ||
                      !editing.target.trim() ||
                      !validPort(editing.port)
                    }
                  >
                    Save host
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="outline"
                    disabled={
                      busy ||
                      !editing.label.trim() ||
                      !editing.target.trim() ||
                      !validPort(editing.port)
                    }
                    onClick={() => void testConnection(editing)}
                  >
                    {connectedEnvironments.length > 1
                      ? `Test from ${selected?.label}`
                      : "Test connection"}
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    disabled={projectScope || busy}
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
                {checks[editing.id]?.pending ? (
                  <span
                    role="status"
                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <Spinner className="size-3" />
                    Checking connection…
                  </span>
                ) : null}
                {checks[editing.id]?.platforms ? (
                  <DeviceHostAvailability platforms={checks[editing.id]?.platforms ?? []} />
                ) : null}
                {checks[editing.id]?.error ? (
                  <p role="alert" className="text-xs text-destructive">
                    {checks[editing.id]?.error}
                  </p>
                ) : null}
              </form>
            ) : null}
          </>
        )}
      </div>
    </SettingsRow>
  );
}

function useHostConnectionChecks(environmentId: EnvironmentId | null) {
  const test = useAtomCommand(deviceEnvironment.testHost, { reportFailure: false });
  const [checks, setChecks] = useState<
    Record<
      string,
      { pending?: boolean; platforms?: ReadonlyArray<DevicePlatformAvailability>; error?: string }
    >
  >({});
  const setCheck = (id: string, value: (typeof checks)[string]) =>
    setChecks((current) => ({ ...current, [id]: value }));
  const testConnection = async (host: SshDeviceHostConfig) => {
    if (!environmentId || checks[host.id]?.pending) return;
    setCheck(host.id, { pending: true });
    try {
      const summary = await test({ environmentId: environmentId, input: host });
      setCheck(
        host.id,
        summary._tag === "Failure"
          ? { error: Cause.pretty(summary.cause) }
          : { platforms: summary.value.platforms },
      );
    } catch (error) {
      setCheck(host.id, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  return { checks, testConnection };
}

function DeviceHostList({
  environmentId,
  hosts,
  busy,
  onEdit,
  onRemove,
}: {
  environmentId: EnvironmentId;
  hosts: ReadonlyArray<SshDeviceHostConfig>;
  busy: boolean;
  onEdit: (host: SshDeviceHostConfig) => void;
  onRemove: (host: SshDeviceHostConfig) => void;
}) {
  const { state } = useDeviceState(environmentId);
  const { checks, testConnection } = useHostConnectionChecks(environmentId);
  return (
    <>
      {hosts.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No device hosts.</p>
      ) : null}
      {hosts.map((host) => {
        const status = state.hostStatuses[host.id];
        const check = checks[host.id];
        const platforms =
          check?.platforms ?? state.hosts.find((value) => value.id === host.id)?.platforms ?? [];
        const progress = check?.pending
          ? "Checking connection…"
          : status?.status === "installing"
            ? "Installing device support…"
            : status?.status === "starting"
              ? "Connecting…"
              : null;
        const error = check?.error ?? (status?.status === "failed" ? status.detail : undefined);
        return (
          <div key={host.id} className="flex items-center gap-2 border-t border-border/50 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm font-medium">{host.label}</p>
                {platforms
                  .filter((platform) => platform.available)
                  .map((platform) => (
                    <Tooltip key={platform.platform}>
                      <TooltipTrigger
                        render={
                          <span
                            tabIndex={0}
                            role="img"
                            aria-label={
                              platform.platform === "ios" ? "iOS available" : "Android available"
                            }
                            className="shrink-0 text-muted-foreground"
                          />
                        }
                      >
                        {platform.platform === "ios" ? (
                          <AppleIcon className="size-3.5" />
                        ) : (
                          <AndroidIcon className="size-3.5" />
                        )}
                      </TooltipTrigger>
                      <TooltipPopup>
                        {platform.platform === "ios" ? "iOS available" : "Android available"}
                      </TooltipPopup>
                    </Tooltip>
                  ))}
              </div>
              <p className="truncate text-xs text-muted-foreground">{host.target}</p>
              {error ? (
                <div className="mt-1" role="status">
                  <details className="text-xs text-destructive">
                    <summary>Connection failed</summary>
                    <p className="mt-1 whitespace-pre-wrap break-words">{error}</p>
                  </details>
                </div>
              ) : null}
            </div>
            {progress ? (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Spinner className="size-3" />
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
                <MenuItem
                  onClick={() => {
                    onEdit(host);
                  }}
                >
                  Edit
                </MenuItem>
                <MenuItem variant="destructive" onClick={() => onRemove(host)}>
                  Remove
                </MenuItem>
              </MenuPopup>
            </Menu>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || progress !== null}
              onClick={() => void testConnection(host)}
            >
              Test connection
            </Button>
          </div>
        );
      })}
    </>
  );
}
