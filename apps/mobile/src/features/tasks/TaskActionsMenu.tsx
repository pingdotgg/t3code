import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import { canSnooze, resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import type { MenuAction } from "@react-native-menu/menu";
import { type ReactNode, useState } from "react";
import { Pressable } from "react-native";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { useEnvironmentServerConfig, useThreadShells } from "../../state/entities";
import { useTaskActions } from "./useTaskActions";

export function TaskActionsMenu({
  task,
  children,
  extraActions,
  onExtraAction,
}: {
  readonly task: EnvironmentTask;
  readonly children?: ReactNode;
  readonly extraActions?: MenuAction[];
  readonly onExtraAction?: (event: string) => void;
}) {
  const actions = useTaskActions();
  const threads = useThreadShells();
  const config = useEnvironmentServerConfig(task.environmentId);
  const [now, setNow] = useState(() => new Date());
  if (config?.environment.capabilities.tasks !== true) return null;
  const presets = resolveSnoozePresets(now);
  const snoozable = threads
    .filter(
      (thread) =>
        thread.environmentId === task.environmentId &&
        thread.taskId === task.id &&
        thread.archivedAt === null,
    )
    .every((thread) => canSnooze(thread, { now: now.toISOString() }));
  const snoozed = task.snoozedUntil !== null && Date.parse(task.snoozedUntil) > now.getTime();
  const menu: MenuAction[] =
    task.archivedAt !== null
      ? [{ id: "unarchive", title: "Unarchive task and members" }]
      : [
          {
            id: task.settledOverride === "settled" ? "unsettle" : "settle",
            title:
              task.settledOverride === "settled" ? "Un-settle task" : "Settle task and members",
          },
          ...(snoozed
            ? [{ id: "unsnooze", title: "Wake task" }]
            : [
                {
                  id: "snooze",
                  title: "Snooze task",
                  attributes: { disabled: !snoozable },
                  subactions: presets.map((preset) => ({
                    id: `snooze:${preset.snoozedUntil}`,
                    title: preset.label,
                  })),
                },
              ]),
          { id: task.pinnedAt ? "unpin" : "pin", title: task.pinnedAt ? "Unpin task" : "Pin task" },
          { id: "archive", title: "Archive task and members" },
        ];
  menu.push(...(extraActions ?? []), {
    id: "delete",
    title: "Delete task…",
    attributes: { destructive: true },
  });
  return (
    <ControlPillMenu
      actions={menu}
      onPressAction={({ nativeEvent: { event } }) => {
        if (event === "delete") actions.confirmDelete(task);
        else if (event.startsWith("snooze:")) void actions.snooze(task, event.slice(7));
        else if (
          event === "settle" ||
          event === "unsettle" ||
          event === "unsnooze" ||
          event === "pin" ||
          event === "unpin" ||
          event === "archive" ||
          event === "unarchive"
        )
          void actions.execute(event, task);
        else onExtraAction?.(event);
      }}
    >
      <Pressable
        onPressIn={() => setNow(new Date())}
        accessibilityLabel={`Actions for ${task.name}`}
        accessibilityRole="button"
        className="min-h-11 min-w-11 items-center justify-center"
      >
        {children ?? <SymbolView name="ellipsis" size={20} tintColorClassName="accent-icon" />}
      </Pressable>
    </ControlPillMenu>
  );
}
