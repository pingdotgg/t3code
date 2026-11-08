import { useRef, useState } from "react";
import { SandboxProfileId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { parseSandboxProfileLimits } from "@t3tools/client-runtime/state/cloudSandbox";
import * as Result from "effect/Result";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import {
  sandboxProfilesList,
  sandboxProfilesSave,
  sandboxProfilesTest,
} from "~/state/cloudSandboxProfiles";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  cloudDriverDisplayName,
  profileIdFromName,
  type CloudSandboxDraft,
} from "./AddEnvironmentDialog.logic";

export function useCloudSandboxProfileSetup({
  draft,
  onChange,
  onError,
}: {
  readonly draft: CloudSandboxDraft;
  readonly onChange: (draft: CloudSandboxDraft) => void;
  readonly onError: (message: string | null) => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const profilesQuery = useEnvironmentQuery(
    environmentId === null ? null : sandboxProfilesList({ environmentId, input: {} }),
  );
  const saveProfile = useAtomCommand(sandboxProfilesSave, { reportFailure: false });
  const testProfile = useAtomCommand(sandboxProfilesTest, { reportFailure: false });
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const session = useRef(0);
  const profiles =
    profilesQuery.data?.profiles
      .map(({ profile }) => profile)
      .filter((profile) => profile.driverKind === draft.driverKind) ?? [];
  const existing =
    profiles.find((profile) => profile.profileId === draft.profileId) ??
    profiles.find((profile) => profile.apiKeySet) ??
    profiles[0] ??
    null;
  const storedKeyAvailable = existing?.apiKeySet === true;
  const check = async () => {
    if (environmentId === null || checking || saving) return false;
    const attempt = session.current;
    const apiKey = draft.apiKey.trim();
    if (apiKey === "" && !storedKeyAvailable) {
      onError(`${cloudDriverDisplayName(draft.driverKind)} API key is required.`);
      return false;
    }
    setChecking(true);
    onError(null);
    const result = await testProfile({
      environmentId,
      input:
        apiKey === "" && existing !== null
          ? { profileId: existing.profileId }
          : { driverKind: draft.driverKind, apiKey },
    });
    if (attempt !== session.current) return false;
    setChecking(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        onError(
          failure instanceof Error ? failure.message : "Could not validate the sandbox credential.",
        );
      }
      return false;
    }
    onChange({
      ...draft,
      profileId: existing?.profileId ?? profileIdFromName(cloudDriverDisplayName(draft.driverKind)),
      defaultSize: existing?.defaultSize ?? draft.defaultSize,
      autoStopMinutes: existing?.autoStopMinutes ?? draft.autoStopMinutes,
      ...(existing === null
        ? {}
        : {
            monthlyBudgetUsd:
              existing.monthlyBudgetUsd === null ? "" : String(existing.monthlyBudgetUsd),
            maxConcurrentSandboxes: existing.maxConcurrentSandboxes,
            template: existing.template ?? "",
          }),
    });
    return true;
  };
  const save = async () => {
    if (environmentId === null || draft.profileId === null || checking || saving) return false;
    const limits = parseSandboxProfileLimits(draft);
    if (Result.isFailure(limits)) {
      onError(limits.failure);
      return false;
    }
    const attempt = session.current;
    setSaving(true);
    onError(null);
    const apiKey = draft.apiKey.trim();
    const result = await saveProfile({
      environmentId,
      input: {
        profileId: SandboxProfileId.make(draft.profileId),
        name: existing?.name ?? cloudDriverDisplayName(draft.driverKind),
        driverKind: draft.driverKind,
        ...(apiKey === "" ? {} : { apiKey }),
        defaultSize: draft.defaultSize,
        autoStopMinutes: draft.autoStopMinutes,
        ...limits.success,
      },
    });
    if (attempt !== session.current) return false;
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        onError(failure instanceof Error ? failure.message : "Could not save the sandbox profile.");
      }
      return false;
    }
    return true;
  };
  return {
    available: environmentId !== null,
    storedKeyAvailable,
    checking,
    saving,
    check,
    save,
    reset: () => {
      session.current++;
      setChecking(false);
      setSaving(false);
    },
  };
}
