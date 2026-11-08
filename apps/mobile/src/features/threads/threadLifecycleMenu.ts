import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";

function snoozeSubmenu(input: {
  readonly presets: ReadonlyArray<SnoozePreset>;
  readonly canSnoozeNow: boolean;
  readonly onSnoozePreset: (presetId: string) => void;
  readonly onCustomSnooze: () => void;
}): AppBarMenuItem {
  return {
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
  };
}

function layoutItems(input: {
  readonly nested: boolean;
  readonly direct: ReadonlyArray<AppBarMenuItem>;
  readonly pin: ReadonlyArray<AppBarMenuItem>;
  readonly secondary: ReadonlyArray<AppBarMenuItem>;
}): ReadonlyArray<AppBarMenuItem> {
  if (!input.nested) return [...input.direct, ...input.pin, ...input.secondary];
  return [
    ...input.direct,
    ...input.pin,
    {
      id: "more",
      title: "More",
      icon: "ellipsis.circle",
      items: [...input.secondary],
    },
  ];
}

export function buildThreadLifecycleMenuItems(input: {
  readonly nested: boolean;
  readonly settlementSupported: boolean;
  readonly settled: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly presets: ReadonlyArray<SnoozePreset>;
  readonly branch: string | null;
  readonly newBranchTitle: string;
  readonly pinned: boolean;
  readonly pinningSupported: boolean;
  readonly arrangeSupported: boolean;
  readonly titleRegenerationSupported: boolean;
  readonly regeneratingTitle: boolean;
  readonly canTurnIntoProject: boolean;
  readonly turnIntoProjectDisabled: boolean;
  readonly autoSettleOptOutSupported: boolean;
  readonly autoSettleEnabled: boolean;
  readonly canRename: boolean;
  readonly onNewThreadOnBranch: () => void;
  readonly onCopyThread: () => void;
  readonly onCopyThreadId: () => void;
  readonly onSettle: () => void;
  readonly onUnsettle: () => void;
  readonly onWake: () => void;
  readonly onSnoozePreset: (presetId: string) => void;
  readonly onCustomSnooze: () => void;
  readonly onPin: () => void;
  readonly onUnpin: () => void;
  readonly onArrange: () => void;
  readonly onRename: () => void;
  readonly onRegenerateTitle: () => void;
  readonly onTurnIntoProject: () => void;
  readonly onSetAutoSettle: (enabled: boolean) => void;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
}): ReadonlyArray<AppBarMenuItem> {
  const leading: AppBarMenuItem[] = [];
  if (input.branch) {
    leading.push({
      id: "new-thread-on-branch",
      title: input.newBranchTitle,
      icon: "square.and.pencil",
      onPress: input.onNewThreadOnBranch,
    });
  }
  leading.push(
    { id: "copy-thread", title: "Copy thread", icon: "text.bubble", onPress: input.onCopyThread },
    {
      id: "copy-thread-id",
      title: "Copy thread ID",
      icon: "doc.on.doc",
      onPress: input.onCopyThreadId,
    },
  );

  const pin: AppBarMenuItem[] =
    input.pinningSupported && !input.snoozed
      ? [
          input.pinned
            ? { id: "unpin", title: "Unpin", icon: "pin.slash", onPress: input.onUnpin }
            : { id: "pin", title: "Pin", icon: "pin", onPress: input.onPin },
        ]
      : [];

  const titleItems: AppBarMenuItem[] = [];
  if (input.canRename) {
    titleItems.push({
      id: "rename",
      title: "Rename",
      icon: "square.and.pencil",
      onPress: input.onRename,
    });
  }
  if (input.titleRegenerationSupported) {
    titleItems.push({
      id: "regenerate-title",
      title: input.regeneratingTitle ? "Regenerating…" : "Regenerate title",
      icon: "arrow.clockwise",
      disabled: input.regeneratingTitle,
      onPress: input.onRegenerateTitle,
    });
  }
  if (input.canTurnIntoProject) {
    titleItems.push({
      id: "turn-into-project",
      title: "Turn into project",
      icon: "folder.badge.plus",
      disabled: input.turnIntoProjectDisabled,
      onPress: input.onTurnIntoProject,
    });
  }

  const autoSettleItems: AppBarMenuItem[] = input.autoSettleOptOutSupported
    ? [
        {
          id: "auto-settle",
          title: "Auto-settle behavior",
          icon: "timer",
          items: [
            {
              id: "auto-settle:enabled",
              title: "Enabled",
              selected: input.autoSettleEnabled,
              onPress: () => input.onSetAutoSettle(true),
            },
            {
              id: "auto-settle:disabled",
              title: "Disabled",
              selected: !input.autoSettleEnabled,
              onPress: () => input.onSetAutoSettle(false),
            },
          ],
        },
      ]
    : [];

  const arrangeItems: AppBarMenuItem[] =
    input.arrangeSupported && !input.snoozed
      ? [
          {
            id: "arrange",
            title: "Arrange threads…",
            icon: "line.3.horizontal",
            onPress: input.onArrange,
          },
        ]
      : [];

  const archive: AppBarMenuItem = {
    id: "archive",
    title: "Archive",
    icon: "archivebox",
    onPress: input.onArchive,
  };
  const deleteItem: AppBarMenuItem = {
    id: "delete",
    title: "Delete",
    icon: "trash",
    destructive: true,
    onPress: input.onDelete,
  };

  if (input.snoozed && input.snoozeSupported) {
    return layoutItems({
      nested: input.nested,
      direct: [
        ...leading,
        { id: "unsnooze", title: "Wake thread", icon: "clock", onPress: input.onWake },
      ],
      pin: [],
      secondary: [...titleItems, ...autoSettleItems, archive, deleteItem],
    });
  }

  if (!input.settlementSupported) {
    return layoutItems({
      nested: input.nested,
      direct: [...leading, archive],
      pin,
      secondary: [...arrangeItems, ...titleItems, deleteItem],
    });
  }

  if (input.settled) {
    return layoutItems({
      nested: input.nested,
      direct: [
        ...leading,
        {
          id: "unsettle",
          title: "Un-settle",
          icon: "arrow.uturn.backward",
          onPress: input.onUnsettle,
        },
      ],
      pin,
      secondary: [...arrangeItems, ...titleItems, ...autoSettleItems, archive, deleteItem],
    });
  }

  const direct: AppBarMenuItem[] = [
    ...leading,
    { id: "settle", title: "Settle", icon: "checkmark", onPress: input.onSettle },
  ];
  if (input.snoozeSupported) {
    direct.push(
      snoozeSubmenu({
        presets: input.presets,
        canSnoozeNow: input.canSnoozeNow,
        onSnoozePreset: input.onSnoozePreset,
        onCustomSnooze: input.onCustomSnooze,
      }),
    );
  }
  return layoutItems({
    nested: input.nested,
    direct,
    pin,
    secondary: [...arrangeItems, ...titleItems, ...autoSettleItems, archive, deleteItem],
  });
}
