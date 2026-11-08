import { useAtomValue } from "@effect/atom-react";
import {
  cloudSandboxControlOperation,
  cloudSandboxFailureMessage,
  countRunningCloudSandboxes,
  describeCloudSandbox,
  describeCloudSandboxProfile,
  offersCloudSandboxControl,
  parseSandboxProfileLimits,
} from "@t3tools/client-runtime/state/cloudSandbox";
import type {
  CloudSandboxProfileStatus,
  EnvironmentId,
  ManagedCloudSandboxResource,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import {
  cloudSandboxOperation,
  deleteManagedSandbox,
  managedSandboxesAtom,
  sandboxProfilesDelete,
  sandboxProfilesList,
  sandboxProfilesSave,
} from "../../state/cloudSandboxes";
import { environmentCatalog } from "../../connection/catalog";
import { connectCloudSandboxEnvironment } from "../../connection/onboarding";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ConnectionFormField } from "./ConnectionFormField";

/** Hidden until the environment has a profile or a sandbox, so users who never set this up see nothing. */
export function CloudSandboxesSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const profiles = useEnvironmentQuery(sandboxProfilesList({ environmentId, input: {} }));
  const sandboxes = useEnvironmentQuery(managedSandboxesAtom(environmentId));
  const profileRows = profiles.data?.profiles ?? [];
  const sandboxRows = sandboxes.data ?? [];
  const { presentationById } = useEnvironments();
  if (profileRows.length === 0 && sandboxRows.length === 0) return null;
  return (
    <>
      {profileRows.length > 0 ? (
        <SettingsSection title="Cloud sandbox profiles">
          {profileRows.map((status) => (
            <SandboxProfileRow
              key={status.profile.profileId}
              environmentId={environmentId}
              status={status}
              running={countRunningCloudSandboxes(sandboxRows, status.profile.profileId)}
            />
          ))}
        </SettingsSection>
      ) : null}
      {sandboxRows.length > 0 ? (
        <SettingsSection title="Cloud sandboxes">
          {sandboxRows.map((resource) => (
            <ManagedSandboxRow
              key={resource.resourceId}
              controllerEnvironmentId={environmentId}
              resource={resource}
              registered={
                resource.environmentId !== null && presentationById.has(resource.environmentId)
              }
              onChanged={sandboxes.refresh}
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
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

  const removeProfile = async () => {
    setPending("remove");
    setError(null);
    const result = await deleteProfile({ environmentId, input: { profileId: profile.profileId } });
    setPending(null);
    if (result._tag === "Failure") {
      setError(cloudSandboxFailureMessage(result, "Could not remove the sandbox profile."));
    }
  };

  const requestRemove = () => {
    Dialog.confirm({
      title: "Remove profile",
      message: "Removes the stored API key. Sandboxes from this profile must be deleted first.",
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => void removeProfile(),
    });
  };

  return (
    <View>
      <ListRowLayout
        label={profile.name}
        description={describeCloudSandboxProfile(status, running)}
      />
      {error ? (
        <Text selectable className="px-4 pb-2 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {editing ? (
        <View className="gap-3 px-4 pb-4">
          <ConnectionFormField
            label="Monthly budget"
            value={budget}
            onChangeText={setBudget}
            placeholder="No limit"
            keyboardType="decimal-pad"
            editable={pending === null}
          />
          <ConnectionFormField
            label="Concurrent sandboxes"
            value={concurrent}
            onChangeText={setConcurrent}
            keyboardType="number-pad"
            editable={pending === null}
          />
          <ConnectionFormField
            label="Template snapshot"
            value={template}
            onChangeText={setTemplate}
            placeholder="None"
            autoCapitalize="none"
            autoCorrect={false}
            editable={pending === null}
          />
          <View className="flex-row justify-end gap-2">
            <Button
              label="Cancel"
              size="compact"
              tone="secondary"
              disabled={pending !== null}
              onPress={() => setEditing(false)}
            />
            <Button
              label={pending === "save" ? "Saving…" : "Save"}
              size="compact"
              tone="primary"
              disabled={pending !== null}
              onPress={() => void save()}
            />
          </View>
        </View>
      ) : (
        <>
          {canSave ? (
            <ListActionRow
              icon="pencil"
              label="Edit"
              disabled={pending !== null}
              onPress={startEditing}
            />
          ) : null}
          {canDelete ? (
            <ListActionRow
              icon="trash"
              tone="danger"
              label={pending === "remove" ? "Removing…" : "Remove"}
              disabled={pending !== null}
              onPress={requestRemove}
            />
          ) : null}
        </>
      )}
    </View>
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
  const execute = useAtomCommand(cloudSandboxOperation, { reportFailure: false });
  const removeSandbox = useAtomCommand(deleteManagedSandbox, { reportFailure: false });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const connect = useAtomCommand(connectCloudSandboxEnvironment, { reportFailure: false });
  const canOpen =
    canControl && !registered && resource.environmentId !== null && resource.phase === "connected";
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

  const deleteConfirmed = async () => {
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

  const requestDelete = () => {
    Dialog.confirm({
      title: "Delete sandbox",
      message: "Deletes this sandbox and its disk. Unsaved work in it is lost.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => void deleteConfirmed(),
    });
  };

  return (
    <View>
      <ListRowLayout label={resource.label} description={describeCloudSandbox(resource)} />
      {error ? (
        <Text selectable className="px-4 pb-2 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {offersCloudSandboxControl(resource.phase) && canControl ? (
        <ListActionRow
          icon={stopped ? "play" : "stop.fill"}
          label={
            pending === "control"
              ? stopped
                ? "Resuming…"
                : "Stopping…"
              : stopped
                ? "Resume"
                : "Stop"
          }
          disabled={pending !== null}
          onPress={() => void control()}
        />
      ) : null}
      {canOpen ? (
        <ListActionRow
          icon="arrow.up.right"
          label={pending === "open" ? "Opening…" : "Open"}
          disabled={pending !== null}
          onPress={() => void open()}
        />
      ) : null}
      {canControl ? (
        <ListActionRow
          icon="trash"
          tone="danger"
          label={pending === "delete" ? "Deleting…" : "Delete"}
          disabled={pending !== null}
          onPress={requestDelete}
        />
      ) : null}
    </View>
  );
}
