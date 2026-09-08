import type { EnvironmentId, SshDeviceHostConfig } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { deviceEnvironment, useDeviceState } from "../../state/device";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

/** Host names and identity paths belong to the selected environment, never all environments. */
export function DeviceHostsSettings(props: {
  environmentId: EnvironmentId | null;
  hosts: ReadonlyArray<SshDeviceHostConfig>;
}) {
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const test = useAtomCommand(deviceEnvironment.testHost, { reportFailure: false });
  const { state } = useDeviceState(props.environmentId);
  const [editing, setEditing] = useState<SshDeviceHostConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const save = async (hosts: ReadonlyArray<SshDeviceHostConfig>) => {
    if (!props.environmentId) return;
    setBusy(true);
    try {
      const saved = await update({
        environmentId: props.environmentId,
        input: { patch: { deviceHosts: hosts } },
      });
      if (saved._tag === "Success") {
        setEditing(null);
        setResult(null);
      }
    } finally {
      setBusy(false);
    }
  };
  const testConnection = async (host: SshDeviceHostConfig) => {
    if (!props.environmentId) return;
    setBusy(true);
    setResult(null);
    try {
      const summary = await test({ environmentId: props.environmentId, input: host });
      if (summary._tag === "Failure") {
        setResult(Cause.pretty(summary.cause));
        return;
      }
      setResult(
        summary.value.platforms
          .map((platform) =>
            platform.available
              ? `${platform.platform === "ios" ? "iOS" : "Android"} available`
              : platform.reason,
          )
          .join(". "),
      );
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection id="device-hosts" title="Device hosts">
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          Connect simulators on other machines over SSH. Keys, aliases, and paths are read on the
          selected environment. Device tools install there on first use.
        </p>
        {!props.environmentId ? (
          <p className="text-sm text-muted-foreground">
            Select one connected environment to manage its device hosts.
          </p>
        ) : (
          <>
            {props.hosts.map((host) => {
              const status = state.hostStatuses[host.id];
              return (
                <div
                  key={host.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{host.label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {host.target}
                      {status ? ` · ${status.status}` : ""}
                    </p>
                    {status?.detail ? (
                      <p className="text-xs text-muted-foreground">{status.detail}</p>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void testConnection(host)}
                  >
                    Test connection
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditing(host);
                      setResult(null);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void save(props.hosts.filter((value) => value.id !== host.id))}
                  >
                    Remove
                  </Button>
                </div>
              );
            })}
            {editing ? (
              <form
                className="space-y-3 rounded-md border p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save([...props.hosts.filter((host) => host.id !== editing.id), editing]);
                }}
              >
                <label className="block space-y-1 text-sm">
                  <span>Name</span>
                  <Input
                    required
                    value={editing.label}
                    disabled={busy}
                    onChange={(event) => setEditing({ ...editing, label: event.target.value })}
                    placeholder="Mac mini"
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>SSH target</span>
                  <Input
                    required
                    value={editing.target}
                    disabled={busy}
                    onChange={(event) => setEditing({ ...editing, target: event.target.value })}
                    placeholder="user@host or SSH alias"
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Identity file, optional</span>
                  <Input
                    value={editing.identityFile ?? ""}
                    disabled={busy}
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
                    disabled={busy}
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
                    disabled={busy || !editing.label.trim() || !editing.target.trim()}
                  >
                    Save host
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="outline"
                    disabled={busy || !editing.target.trim()}
                    onClick={() => void testConnection(editing)}
                  >
                    Test connection
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditing(null);
                      setResult(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setEditing({ id: randomUUID(), label: "", target: "" });
                  setResult(null);
                }}
              >
                Add SSH host
              </Button>
            )}
            {result ? (
              <p role="status" className="text-sm text-muted-foreground">
                {result}
              </p>
            ) : null}
          </>
        )}
      </div>
    </SettingsSection>
  );
}
