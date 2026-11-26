import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import { useGT } from "gt-react-native";

import type { PullAction } from "../../components/PullActionWheel";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";
import { useThreadListActions } from "../home/useThreadListActions";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";

export const THREAD_PULL_DEFAULT_ACTION = 1;

export function useThreadPullActions(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly canSettle: boolean;
  readonly canSnooze: boolean;
  readonly now: string;
  readonly snoozePresets: ReadonlyArray<SnoozePresetSetting> | undefined;
}): ReadonlyArray<PullAction> {
  const gt = useGT();
  const { startNewTaskInThreadProject } = useAdaptiveWorkspaceLayout();
  const { settleThread, snoozeThread } = useThreadListActions();
  const { environmentId, threadId, snoozePresets } = input;
  const firstSnoozePreset = (now: Date) =>
    resolveSnoozePresets(now, snoozePresets ? { presets: snoozePresets } : {}, m)[0];
  // Read when the pull lets go, so the actions don't change while a reply streams into the shell.
  const liveThread = () =>
    appAtomRegistry.get(environmentThreadShells.threadShellAtom({ environmentId, threadId }));
  return [
    {
      id: "settle",
      icon: "checkmark",
      label: gt("Settle", { $context: "verb, thread action" }),
      tone: "success",
      enabled: input.canSettle,
      run: () => {
        const thread = liveThread();
        if (thread) void settleThread(thread);
      },
    },
    {
      id: "new-thread",
      icon: "square.and.pencil",
      label: gt("New", { $context: "short label under a button that starts a new thread" }),
      tone: "primary",
      enabled: true,
      run: () => startNewTaskInThreadProject({ environmentId, threadId }),
    },
    {
      id: "snooze",
      icon: "clock",
      label: gt("Snooze", { $context: "verb, thread action" }),
      tone: "warning",
      enabled: input.canSnooze && firstSnoozePreset(new Date(input.now)) !== undefined,
      run: () => {
        const thread = liveThread();
        const preset = firstSnoozePreset(new Date());
        if (thread && preset) void snoozeThread(thread, preset.snoozedUntil);
      },
    },
  ];
}
