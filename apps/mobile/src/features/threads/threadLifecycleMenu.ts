import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";

export function buildThreadLifecycleMenuItems(input: {
  readonly settlementSupported: boolean;
  readonly settled: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly presets: ReadonlyArray<SnoozePreset>;
  readonly canRename: boolean;
  readonly onSettle: () => void;
  readonly onUnsettle: () => void;
  readonly onWake: () => void;
  readonly onSnoozePreset: (presetId: string) => void;
  readonly onCustomSnooze: () => void;
  readonly onRename: () => void;
}): ReadonlyArray<AppBarMenuItem> {
  const items: AppBarMenuItem[] = [];
  if (input.settlementSupported) {
    items.push(
      input.settled
        ? {
            id: "unsettle",
            title: "Un-settle thread",
            icon: "arrow.uturn.backward",
            onPress: input.onUnsettle,
          }
        : {
            id: "settle",
            title: "Settle thread",
            icon: "checkmark",
            onPress: input.onSettle,
          },
    );
  }
  if (input.snoozeSupported) {
    if (input.snoozed) {
      items.push({
        id: "unsnooze",
        title: "Wake thread",
        icon: "clock",
        onPress: input.onWake,
      });
    } else {
      items.push({
        id: "snooze",
        title: "Snooze",
        icon: "clock",
        items: [
          ...input.presets.map((preset): AppBarMenuItem => ({
            id: `snooze:${preset.id}`,
            title: preset.label,
            subtitle: preset.whenLabel,
            disabled: !input.canSnoozeNow,
            onPress: () => input.onSnoozePreset(preset.id),
          })),
          {
            id: "snooze:custom",
            title: "Custom…",
            disabled: !input.canSnoozeNow,
            onPress: input.onCustomSnooze,
          },
        ],
      });
    }
  }
  if (input.canRename) {
    items.push({
      id: "rename",
      title: "Rename thread",
      icon: "pencil",
      onPress: input.onRename,
    });
  }
  return items;
}
