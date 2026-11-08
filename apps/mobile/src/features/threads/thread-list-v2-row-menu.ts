import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { getThreadListV2NewBranchMenuTitle } from "./thread-list-v2-row-appearance";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import { layoutThreadListV2RowMenuActions } from "./threadListV2";

const CARD_MENU_ACTIONS: MenuAction[] = [
  { id: "settle", title: "Settle", image: "checkmark" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const SLIM_MENU_ACTIONS: MenuAction[] = [
  { id: "unsettle", title: "Un-settle", image: "arrow.uturn.backward" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const SNOOZED_MENU_ACTIONS: MenuAction[] = [
  { id: "unsnooze", title: "Wake thread", image: "clock" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const LEGACY_MENU_ACTIONS: MenuAction[] = [
  { id: "archive", title: "Archive", image: "archivebox" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

export function buildThreadListV2RowMenuActions(input: {
  readonly thread: EnvironmentThreadShell;
  readonly nested: boolean;
  readonly settlementSupported: boolean;
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly includeSnooze: boolean;
  readonly snoozePresetActions: ReadonlyArray<MenuAction>;
  readonly pinningSupported: boolean;
  readonly reorderSupported: boolean;
  readonly canMoveUp?: boolean;
  readonly canMoveDown?: boolean;
  readonly titleRegenerationSupported: boolean;
  readonly canTurnIntoProject: boolean;
  readonly turnIntoProjectDisabled?: boolean;
  readonly autoSettleOptOutSupported: boolean;
}): MenuAction[] {
  const nested = input.nested;
  const thread = input.thread;
  const direct: MenuAction[] = [
    ...(thread.branch
      ? [
          {
            id: "new-thread-on-branch",
            title: getThreadListV2NewBranchMenuTitle(thread.branch),
            image: "square.and.pencil",
          } satisfies MenuAction,
        ]
      : []),
    { id: "copy-thread", title: "Copy thread", image: "text.bubble" },
    { id: "copy-thread-id", title: "Copy thread ID", image: "doc.on.doc" },
  ];
  const pinMenuItems: MenuAction[] = input.pinningSupported
    ? [
        thread.pinnedAt != null
          ? { id: "unpin", title: "Unpin", image: "pin.slash" }
          : { id: "pin", title: "Pin", image: "pin" },
      ]
    : [];
  const reorderMenuItems: MenuAction[] = input.reorderSupported
    ? [
        { id: "arrange", title: "Arrange threads…", image: "line.3.horizontal" },
        {
          id: "move-up",
          title: "Move up",
          image: "arrow.up",
          attributes: { disabled: input.canMoveUp !== true },
        },
        {
          id: "move-down",
          title: "Move down",
          image: "arrow.down",
          attributes: { disabled: input.canMoveDown !== true },
        },
      ]
    : [];
  const titleMenuItems: MenuAction[] = [
    { id: "rename", title: "Rename", image: "square.and.pencil" },
    ...buildThreadTitleRegenerationMenuItems({
      supported: input.titleRegenerationSupported,
      isRegenerating: thread.titleRegeneration != null,
    }),
    ...(input.canTurnIntoProject
      ? [
          {
            id: "turn-into-project",
            title: "Turn into project",
            image: "folder.badge.plus",
            attributes: { disabled: input.turnIntoProjectDisabled === true },
          } satisfies MenuAction,
        ]
      : []),
  ];
  const autoSettleMenuItems: MenuAction[] = input.autoSettleOptOutSupported
    ? [
        {
          id: "auto-settle",
          title: "Auto-settle behavior",
          image: "timer",
          subactions: [
            {
              id: "auto-settle:enabled",
              title: "Follow settings",
              state: thread.autoSettleDisabledAt == null ? "on" : "off",
            },
            {
              id: "auto-settle:disabled",
              title: "Never",
              state: thread.autoSettleDisabledAt == null ? "off" : "on",
            },
          ],
        },
      ]
    : [];

  if (input.snoozed) {
    return layoutThreadListV2RowMenuActions({
      nested,
      direct: [...direct, SNOOZED_MENU_ACTIONS[0]!],
      reorder: [],
      pin: [],
      secondary: [
        ...titleMenuItems,
        ...autoSettleMenuItems,
        LEGACY_MENU_ACTIONS[0]!,
        SNOOZED_MENU_ACTIONS[1]!,
      ],
    });
  }
  if (!input.settlementSupported) {
    return layoutThreadListV2RowMenuActions({
      nested,
      direct: [...direct, LEGACY_MENU_ACTIONS[0]!],
      reorder: reorderMenuItems,
      pin: pinMenuItems,
      secondary: [...titleMenuItems, LEGACY_MENU_ACTIONS[1]!],
    });
  }
  if (input.settled) {
    return layoutThreadListV2RowMenuActions({
      nested,
      direct: [...direct, SLIM_MENU_ACTIONS[0]!],
      reorder: reorderMenuItems.filter(
        (action) => action.id !== "move-up" && action.id !== "move-down",
      ),
      pin: pinMenuItems,
      secondary: [
        ...titleMenuItems,
        ...autoSettleMenuItems,
        LEGACY_MENU_ACTIONS[0]!,
        SLIM_MENU_ACTIONS[1]!,
      ],
    });
  }
  return layoutThreadListV2RowMenuActions({
    nested,
    direct: [
      ...direct,
      CARD_MENU_ACTIONS[0]!,
      ...(input.includeSnooze
        ? [
            {
              id: "snooze",
              title: "Snooze",
              image: "clock",
              subactions: [...input.snoozePresetActions],
            },
          ]
        : []),
    ],
    reorder: reorderMenuItems,
    pin: pinMenuItems,
    secondary: [
      ...titleMenuItems,
      ...autoSettleMenuItems,
      LEGACY_MENU_ACTIONS[0]!,
      CARD_MENU_ACTIONS[1]!,
    ],
  });
}
