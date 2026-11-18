import { useGT } from "gt-react-native";
import type { EnvironmentId, ServerSettingsPatch } from "@t3tools/contracts";
import { worktreeSettingsPatchApplied } from "@t3tools/shared/serverSettings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import * as Dialog from "../../components/ui/Dialog";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ScopedMobileSettingsTarget } from "./settings-scoped-server";

export function useSettingsWriter() {
  const gt = useGT();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "environment settings update",
    reportFailure: true,
  });

  return async (
    targets: readonly ScopedMobileSettingsTarget[],
    writes: readonly {
      readonly environmentId: EnvironmentId;
      readonly patch: ServerSettingsPatch;
    }[],
  ) => {
    const outcomes = await Promise.all(
      writes.map(async (entry) => {
        const result = await updateSettings({
          environmentId: entry.environmentId,
          input: { patch: entry.patch },
        });
        const label =
          targets.find((target) => target.environment.environmentId === entry.environmentId)
            ?.environment.label ?? entry.environmentId;
        if (result._tag === "Success") {
          return worktreeSettingsPatchApplied(entry.patch, result.value)
            ? null
            : gt("{label}: Update T3 Code on this environment to save worktree settings.", {
                label,
              });
        }
        if (isAtomCommandInterrupted(result)) return null;
        const error = squashAtomCommandFailure(result);
        return gt("{environment}: {error}", {
          environment: label,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
    const failures = outcomes.filter((outcome) => outcome !== null);
    if (failures.length > 0) {
      Dialog.alert(gt("Could not save settings"), failures.join("\n\n"));
    }
  };
}
