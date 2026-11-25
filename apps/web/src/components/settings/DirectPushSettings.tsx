import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { DirectPushTestResult, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useRef, useState } from "react";

import { directPushEnvironment, directPushStatus } from "../../state/directPush";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";

const DESCRIPTION =
  "Phones running a T3 Code build signed with your own Apple team register here. Notifications go straight from this environment to Apple, without T3 Connect.";

function failureText<A, E>(result: AtomCommandResult<A, E>): string | null {
  if (result._tag === "Success") return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : String(failure);
}

function testToast(result: DirectPushTestResult) {
  const failed = result.deliveries.filter((delivery) => !delivery.ok);
  if (result.deliveries.length === 0) {
    return { type: "warning" as const, title: "No phones registered" };
  }
  if (failed.length === 0) {
    return {
      type: "success" as const,
      title: `Test sent to ${result.deliveries.map((delivery) => delivery.label).join(", ")}`,
    };
  }
  return {
    type: "error" as const,
    title: `Test failed on ${failed.length} of ${result.deliveries.length} phones`,
    description: failed
      .map((delivery) => `${delivery.label}: ${delivery.error ?? "Unknown error"}`)
      .join("\n"),
  };
}

/** One row per environment in the settings scope whose server sends its own pushes. */
export function DirectPushSettings() {
  const { connectedEnvironments } = useSettingsScope();
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.directPush === true,
  );
  return supported.map((environment, index) => (
    <DirectPushRow
      key={environment.environmentId}
      environmentId={environment.environmentId}
      label={supported.length > 1 ? environment.label : null}
      searchable={index === 0}
    />
  ));
}

function DirectPushRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly searchable: boolean;
}) {
  const { environmentId } = props;
  const statusAtom = directPushStatus({ environmentId, input: {} });
  const status = useAtomValue(statusAtom);
  const refreshStatus = useAtomRefresh(statusAtom);
  const canWrite = useAtomValue(directPushEnvironment.setCredentials.permissionAtom(environmentId));
  const setCredentials = useAtomCommand(directPushEnvironment.setCredentials, {
    reportFailure: false,
  });
  const clearCredentials = useAtomCommand(directPushEnvironment.clearCredentials, {
    reportFailure: false,
  });
  const sendTest = useAtomCommand(directPushEnvironment.sendTest, { reportFailure: false });

  const [editing, setEditing] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const value = status._tag === "Success" ? status.value : null;
  const loadError =
    status._tag === "Failure"
      ? (() => {
          const failure = Cause.squash(status.cause);
          return failure instanceof Error ? failure.message : String(failure);
        })()
      : null;
  const credentials = value?.credentials ?? null;
  const canSave =
    teamId.trim() !== "" && keyId.trim() !== "" && privateKey.trim() !== "" && !busy && canWrite;

  const run = async <A, E>(action: () => Promise<AtomCommandResult<A, E>>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    setError(failureText(result));
    refreshStatus();
    return result;
  };

  const save = async () => {
    const result = await run(() =>
      setCredentials({
        environmentId,
        input: { teamId: teamId.trim(), keyId: keyId.trim(), privateKey: privateKey.trim() },
      }),
    );
    if (result._tag === "Success") {
      setEditing(false);
      setPrivateKey("");
    }
  };

  const test = async () => {
    const result = await run(() => sendTest({ environmentId, input: {} }));
    if (result._tag === "Success") toastManager.add(testToast(result.value));
  };

  const searchable = useSearchableSetting()("phone-notifications");
  const title = props.label ? `${searchable.title} · ${props.label}` : searchable.title;

  return (
    <SettingsRow
      {...(props.searchable ? { id: searchable.id } : {})}
      title={title}
      description={DESCRIPTION}
      serverScoped
      status={
        loadError ??
        (value === null
          ? "Loading…"
          : credentials === null
            ? "Not set up"
            : `Apple key ${credentials.keyId} (team ${credentials.teamId})`)
      }
      control={
        value === null ? null : (
          <>
            {credentials !== null ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !canWrite || value.devices.length === 0}
                  onClick={() => void test()}
                >
                  Send test
                </Button>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={busy || !canWrite}
                  onClick={() => void run(() => clearCredentials({ environmentId, input: {} }))}
                >
                  Remove
                </Button>
              </>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canWrite}
              onClick={() => {
                setEditing(!editing);
                setError(null);
                setTeamId(credentials?.teamId ?? "");
                setKeyId(credentials?.keyId ?? "");
                setPrivateKey("");
              }}
            >
              {editing ? "Cancel" : credentials === null ? "Set up" : "Replace key"}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3 pb-2">
        {value !== null && value.devices.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
            {value.devices.map((device) => (
              <li key={device.deviceId}>
                <span className="text-foreground">{device.label}</span>
                {device.lastError ? ` · Last delivery failed: ${device.lastError}` : null}
              </li>
            ))}
          </ul>
        ) : value !== null ? (
          <p className="text-xs text-muted-foreground">
            No phones registered. Turn on notifications in the app's settings while it is connected
            here.
          </p>
        ) : null}
        {editing ? (
          <div className="flex max-w-xl flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`direct-push-team-${environmentId}`}>Team ID</Label>
                <Input
                  id={`direct-push-team-${environmentId}`}
                  size="sm"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={teamId}
                  onChange={(event) => setTeamId(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`direct-push-key-${environmentId}`}>Key ID</Label>
                <Input
                  id={`direct-push-key-${environmentId}`}
                  size="sm"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={keyId}
                  onChange={(event) => setKeyId(event.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`direct-push-p8-${environmentId}`}>Private key (.p8)</Label>
                <Button size="xs" variant="ghost" onClick={() => fileInput.current?.click()}>
                  Choose file…
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".p8"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    const match = /AuthKey_([A-Z0-9]+)\.p8$/i.exec(file.name);
                    if (match?.[1] && keyId.trim() === "") setKeyId(match[1].toUpperCase());
                    void file.text().then(setPrivateKey);
                  }}
                />
              </div>
              <Textarea
                id={`direct-push-p8-${environmentId}`}
                size="sm"
                rows={4}
                spellCheck={false}
                placeholder="-----BEGIN PRIVATE KEY-----"
                value={privateKey}
                onChange={(event) => setPrivateKey(event.target.value)}
              />
            </div>
            <div className="flex justify-end">
              <Button size="sm" disabled={!canSave} onClick={() => void save()}>
                Save
              </Button>
            </div>
          </div>
        ) : null}
        {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      </div>
    </SettingsRow>
  );
}
