import { managedRuntimeModeDenial } from "@t3tools/client-runtime/contract-labels";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  clampManagedRuntimeMode,
  type ManagedPolicySummary,
  type RuntimeMode,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { selectThreadRuntimeMode } from "../../state/thread-runtime-mode";
import { useComposerDraftSettings } from "../../state/use-composer-drafts";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { runtimeModeChoicesForSupportedModes } from "./thread-settings-options";

/**
 * Shown while a thread's mode is above its environment's managed ceiling, where the server
 * refuses every turn. Switching updates the thread's mode right away when safe.
 */
export function ManagedRuntimeModeNotice(props: {
  readonly thread: EnvironmentThreadShell;
  readonly selectedThreadDetailRef: ScopedThreadRef | null;
  readonly threadKey: string;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  readonly policy: ManagedPolicySummary | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const draftSettings = useComposerDraftSettings(props.threadKey);
  const structure = useQuietThreadStructure(props.selectedThreadDetailRef);
  const runtimeMode = draftSettings.runtimeMode ?? props.thread.runtimeMode;
  const denial = managedRuntimeModeDenial(props.policy, runtimeMode, messages);
  if (denial === undefined) return null;
  const choices = runtimeModeChoicesForSupportedModes(props.supportedRuntimeModes);
  const target = clampManagedRuntimeMode(
    props.policy,
    runtimeMode,
    choices.map((choice) => choice.mode),
  );
  const targetLabel = choices.find((choice) => choice.mode === target)?.label;
  return (
    <View className="gap-2 px-4 pb-3">
      <AppText textRole="footnote" className="text-foreground-muted">
        {gt("{denial} Switch this thread's mode to continue.", { denial })}
      </AppText>
      {target === undefined || targetLabel === undefined ? null : (
        <Button
          label={gt("Switch to {mode}", { mode: messages(targetLabel) })}
          onPress={() =>
            selectThreadRuntimeMode({
              thread: props.thread,
              projection: structure?.projection,
              isPendingCreation: props.selectedThreadDetailRef === null,
              runtimeMode: target,
            })
          }
        />
      )}
    </View>
  );
}
