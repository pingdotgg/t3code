import { useAtomValue } from "@effect/atom-react";
import type {
  CloudSandboxProfileStatus,
  EnvironmentId,
  ManagedCloudSandboxResource,
} from "@t3tools/contracts";
import {
  cloudSandboxControlOperation,
  cloudSandboxFailureMessage,
  countRunningCloudSandboxes,
  describeCloudSandbox,
  describeCloudSandboxProfile,
  offersCloudSandboxControl,
  parseSandboxProfileLimits,
} from "@t3tools/client-runtime/state/cloudSandbox";
import * as Result from "effect/Result";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { environmentCatalog } from "~/connection/catalog";
import {
  cloudSandboxOperation,
  deleteManagedSandbox,
  managedSandboxesAtom,
} from "~/connection/cloudSandbox";
import { connectCloudSandboxEnvironment } from "~/connection/onboarding";
import {
  sandboxProfilesDelete,
  sandboxProfilesList,
  sandboxProfilesSave,
} from "~/state/cloudSandboxProfiles";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Hidden until the server has a profile or a sandbox, so users who never set this up see nothing. */
export function CloudSandboxesSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const profiles = useEnvironmentQuery(
    environmentId === null ? null : sandboxProfilesList({ environmentId, input: {} }),
  );
  const sandboxes = useEnvironmentQuery(
    environmentId === null ? null : managedSandboxesAtom(environmentId),
  );
  const profileRows = profiles.data?.profiles ?? [];
  const sandboxRows = sandboxes.data ?? [];
  if (environmentId === null || (profileRows.length === 0 && sandboxRows.length === 0)) {
    return null;
  }
  const registeredIds = new Set(environments.map((environment) => environment.environmentId));
  const search = searchableSetting("cloud-sandboxes");
  return (
    <SettingsSection {...search}>
      {profileRows.length > 0 ? (
        <div>
          <h3 className="px-3 pt-3 text-xs font-medium text-muted-foreground sm:px-4">Profiles</h3>
          {profileRows.map((status) => (
            <SandboxProfileRow
              key={status.profile.profileId}
              environmentId={environmentId}
              status={status}
              running={countRunningCloudSandboxes(sandboxRows, status.profile.profileId)}
            />
          ))}
        </div>
      ) : null}
      {sandboxRows.length > 0 ? (
        <div>
          <h3 className="px-3 pt-3 text-xs font-medium text-muted-foreground sm:px-4">Sandboxes</h3>
          {sandboxRows.map((resource) => (
            <ManagedSandboxRow
              key={resource.resourceId}
              controllerEnvironmentId={environmentId}
              resource={resource}
              registered={
                resource.environmentId !== null && registeredIds.has(resource.environmentId)
              }
              onChanged={sandboxes.refresh}
            />
          ))}
        </div>
      ) : null}
    </SettingsSection>
  );
}

function SandboxProfileRow({
  environmentId,
  status,
  running,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: CloudSandboxProfileStatus;
  readonly running: number;
}) {
  const { profile } = status;
  const canSave = useAtomValue(sandboxProfilesSave.permissionAtom(environmentId));
  const canDelete = useAtomValue(sandboxProfilesDelete.permissionAtom(environmentId));
  const saveProfile = useAtomCommand(sandboxProfilesSave, { reportFailure: false });
  const deleteProfile = useAtomCommand(sandboxProfilesDelete, { reportFailure: false });
  const [editing, setEditing] = useState(false);
  const [budget, setBudget] = useState("");
  const [concurrent, setConcurrent] = useState("");
  const [template, setTemplate] = useState("");
  const [pending, setPending] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startEditing = () => {
    setBudget(profile.monthlyBudgetUsd === null ? "" : String(profile.monthlyBudgetUsd));
    setConcurrent(String(profile.maxConcurrentSandboxes));
    setTemplate(profile.template ?? "");
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    // Number("") is 0, which the limit check rejects, so a blank cap needs no special case.
    const limits = parseSandboxProfileLimits({
      monthlyBudgetUsd: budget,
      maxConcurrentSandboxes: Number(concurrent.trim()),
      template,
    });
    if (Result.isFailure(limits)) {
      setError(limits.failure);
      return;
    }
    setPending("save");
    setError(null);
    const result = await saveProfile({
      environmentId,
      input: {
        profileId: profile.profileId,
        name: profile.name,
        driverKind: profile.driverKind,
        defaultSize: profile.defaultSize,
        autoStopMinutes: profile.autoStopMinutes,
        ...limits.success,
      },
    });
    setPending(null);
    if (result._tag === "Failure") {
      setError(cloudSandboxFailureMessage(result, "Could not save the sandbox profile."));
      return;
    }
    setEditing(false);
  };

  const remove = async () => {
    const confirmed = await (requestConfirmDialog(
      "Removes the stored API key. Sandboxes from this profile must be deleted first.",
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setPending("remove");
    setError(null);
    const result = await deleteProfile({ environmentId, input: { profileId: profile.profileId } });
    setPending(null);
    if (result._tag === "Failure") {
      setError(cloudSandboxFailureMessage(result, "Could not remove the sandbox profile."));
    }
  };

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-sm font-medium text-foreground">{profile.name}</h3>
          <p className="text-xs text-muted-foreground">
            {describeCloudSandboxProfile(status, running)}
          </p>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        {!editing && (canSave || canDelete) ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {canSave ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pending !== null}
                onClick={startEditing}
              >
                Edit
              </Button>
            ) : null}
            {canDelete ? (
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={pending !== null}
                onClick={() => void remove()}
              >
                {pending === "remove" ? "Removing…" : "Remove"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {editing ? (
        <form
          className="grid gap-3 pt-3 sm:grid-cols-3"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="block space-y-1.5">
            <span className="block text-xs font-medium text-foreground">Monthly budget</span>
            <Input
              size="sm"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              placeholder="No limit"
              inputMode="decimal"
              disabled={pending !== null}
              nativeInput
              spellCheck={false}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="block text-xs font-medium text-foreground">Concurrent sandboxes</span>
            <Input
              size="sm"
              type="number"
              min={1}
              max={100}
              step={1}
              inputMode="numeric"
              value={concurrent}
              onChange={(event) => setConcurrent(event.target.value)}
              disabled={pending !== null}
              nativeInput
            />
          </label>
          <label className="block space-y-1.5">
            <span className="block text-xs font-medium text-foreground">Template snapshot</span>
            <Input
              size="sm"
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              placeholder="None"
              disabled={pending !== null}
              nativeInput
              spellCheck={false}
            />
          </label>
          <div className="flex items-center justify-end gap-2 sm:col-span-3">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={pending !== null}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={pending !== null}>
              {pending === "save" ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function ManagedSandboxRow({
  controllerEnvironmentId,
  resource,
  registered,
  onChanged,
}: {
  readonly controllerEnvironmentId: EnvironmentId;
  readonly resource: ManagedCloudSandboxResource;
  readonly registered: boolean;
  readonly onChanged: () => void;
}) {
  const stopped = resource.phase === "stopped";
  const controlOperation = cloudSandboxControlOperation(resource);
  const canControl = useAtomValue(
    cloudSandboxOperation.permissionAtom(controllerEnvironmentId, {
      resourceId: resource.resourceId,
      operation: controlOperation,
    }),
  );
  // Open and delete need the same operate scope on the controller as stop and resume.
  const canOpen = canControl && resource.environmentId !== null && resource.phase === "connected";
  const canDelete = canControl;
  const execute = useAtomCommand(cloudSandboxOperation, { reportFailure: false });
  const connect = useAtomCommand(connectCloudSandboxEnvironment, { reportFailure: false });
  const removeSandbox = useAtomCommand(deleteManagedSandbox, { reportFailure: false });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const [pending, setPending] = useState<"control" | "open" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const control = async () => {
    setPending("control");
    setError(null);
    const result = await execute({
      environmentId: controllerEnvironmentId,
      input: { resourceId: resource.resourceId, operation: controlOperation },
    });
    setPending(null);
    if (result._tag === "Failure") {
      setError(cloudSandboxFailureMessage(result, "The sandbox did not change state."));
    }
    onChanged();
  };

  const open = async () => {
    setPending("open");
    setError(null);
    const result = await connect({
      controllerEnvironmentId,
      resourceId: resource.resourceId,
      label: resource.label,
    });
    setPending(null);
    if (result._tag === "Failure") {
      setError(cloudSandboxFailureMessage(result, "Could not open the sandbox."));
    }
    onChanged();
  };

  const destroy = async () => {
    const confirmed = await (requestConfirmDialog(
      "Deletes this sandbox and its disk. Unsaved work in it is lost.",
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setPending("delete");
    setError(null);
    const result = await removeSandbox({
      controllerEnvironmentId,
      resourceId: resource.resourceId,
    });
    if (result._tag === "Failure") {
      setError(cloudSandboxFailureMessage(result, "Could not delete the sandbox."));
    } else if (registered && resource.environmentId !== null) {
      const removed = await removeEnvironment(resource.environmentId);
      const message = cloudSandboxFailureMessage(removed, "Could not remove the environment.");
      if (message) setError(message);
    }
    setPending(null);
    onChanged();
  };

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-sm font-medium text-foreground">{resource.label}</h3>
          <p className="text-xs text-muted-foreground">{describeCloudSandbox(resource)}</p>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {offersCloudSandboxControl(resource.phase) && canControl ? (
            <Button
              size="xs"
              variant="outline"
              disabled={pending !== null}
              onClick={() => void control()}
            >
              {pending === "control"
                ? stopped
                  ? "Resuming…"
                  : "Stopping…"
                : stopped
                  ? "Resume"
                  : "Stop"}
            </Button>
          ) : null}
          {canOpen ? (
            registered ? (
              <span className="text-xs text-muted-foreground">Opened</span>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void open()}
              >
                {pending === "open" ? "Opening…" : "Open"}
              </Button>
            )
          ) : null}
          {canDelete ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={pending !== null}
              onClick={() => void destroy()}
            >
              {pending === "delete" ? "Deleting…" : "Delete"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
