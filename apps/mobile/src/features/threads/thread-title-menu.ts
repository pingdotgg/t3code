import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  canSnooze,
  effectiveSnoozed,
  resolveSnoozePresets,
} from "@t3tools/client-runtime/state/thread-settled";
import type { ServerConfig } from "@t3tools/contracts";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";

export function buildThreadTitleMenu(input: {
  readonly thread: EnvironmentThreadShell;
  readonly capabilities:
    | Pick<
        ServerConfig["environment"]["capabilities"],
        "threadSettlement" | "threadSnooze" | "threadPinning" | "threadTitleRegeneration"
      >
    | undefined;
  readonly snoozePresets?: ServerConfig["settings"]["snoozePresets"] | undefined;
  readonly canOperate: boolean;
  readonly hasQueuedMessages: boolean;
  readonly now: Date;
}): MenuAction[] {
  const { thread, capabilities, now } = input;
  const actions: MenuAction[] = [];
  if (input.canOperate) {
    if (capabilities?.threadSettlement) {
      actions.push(
        (thread.settledOverride === "settled" || thread.settledAt != null) &&
          !input.hasQueuedMessages
          ? { id: "unsettle", title: "Un-settle", image: "arrow.uturn.backward" }
          : { id: "settle", title: "Settle", image: "checkmark" },
      );
    }
    if (capabilities?.threadSnooze) {
      if (effectiveSnoozed(thread, { now: now.toISOString() })) {
        actions.push({ id: "unsnooze", title: "Wake now", image: "sun.max" });
      } else if (canSnooze(thread, { now: now.toISOString() })) {
        actions.push({
          id: "snooze",
          title: "Snooze",
          image: "clock",
          subactions: [
            ...resolveSnoozePresets(
              now,
              input.snoozePresets ? { presets: input.snoozePresets } : {},
            ).map((preset) => ({
              id: `snooze:${preset.snoozedUntil}`,
              title: preset.label,
              subtitle: preset.whenLabel,
            })),
            { id: "snooze:custom", title: "Custom…" },
          ],
        });
      }
    }
    if (capabilities?.threadPinning) {
      actions.push(
        thread.pinnedAt != null
          ? { id: "unpin", title: "Unpin", image: "pin.slash" }
          : { id: "pin", title: "Pin", image: "pin" },
      );
    }
    actions.push(
      { id: "rename", title: "Rename", image: "square.and.pencil" },
      ...buildThreadTitleRegenerationMenuItems({
        supported: capabilities?.threadTitleRegeneration === true,
        isRegenerating: thread.titleRegeneration != null,
      }),
    );
  }
  actions.push({ id: "copy-thread-id", title: "Copy thread ID", image: "doc.on.doc" });
  if (input.canOperate)
    actions.push({
      id: "delete",
      title: "Delete",
      image: "trash",
      attributes: { destructive: true },
    });
  return actions;
}

/** The native header only needs new content when its title or actions change. */
export function threadTitleMenuVersion(thread: EnvironmentThreadShell | null) {
  if (thread === null) return null;
  return [
    thread.environmentId,
    thread.id,
    thread.title,
    thread.settledOverride,
    thread.settledAt,
    thread.pinnedAt,
    // Unpin's Undo restores the captured key, so another client's reorder must reach the menu.
    thread.pinOrderKey,
    thread.snoozedAt,
    thread.snoozedUntil,
    thread.hasPendingApprovals,
    thread.hasPendingUserInput,
    // Nonblocking questions leave both flags false but still block snoozing.
    thread.source.pendingRuntimeRequest != null,
    thread.pendingSubagentRequest,
    thread.pendingGuestMessageCount,
    thread.latestUserMessageAt,
    thread.latestRun?.status,
    thread.latestRun?.requestedAt,
    thread.latestRun?.startedAt,
    thread.latestRun?.completedAt,
    thread.runtime?.status,
    thread.runtime?.status === "failed" ? thread.runtime.updatedAt : null,
    thread.titleRegeneration,
  ];
}

/**
 * A native menu can deliver a choice made before its actions changed, such as a client-only
 * thread losing mutations. Only dispatch events the current menu still offers.
 */
export function threadTitleMenuOffers(actions: ReadonlyArray<MenuAction>, event: string) {
  const id = event.startsWith("snooze:") ? "snooze" : event;
  return actions.some((action) => action.id === id);
}

/** Carry the displayed instant in the action ID, even if the menu spans midnight. */
export function threadTitleSnoozeUntil(event: string, now: Date): string | null {
  if (!event.startsWith("snooze:")) return null;
  const until = event.slice("snooze:".length);
  return Date.parse(until) > now.getTime() ? until : null;
}

type NativeHeaderItems = ReadonlyArray<Record<string, unknown>>;

/**
 * Native-stack only returns the title's position to Yoga, so custom title content needs its
 * own width cap. Reserves the horizontal controls and gaps, keeping a 44-point trigger when
 * UIKit must compress or overflow controls in a narrow pane. A vertical bar holds icon items
 * and separates them itself, so only `horizontalOnly` items stay in this bar.
 */
export function threadTitleMaxWidth(input: {
  readonly paneWidth: number;
  readonly horizontalInsets: number;
  readonly verticalBar: boolean;
  /** Split-view leading items; null when the bar leads with Back or a home button. */
  readonly leadingItems: NativeHeaderItems | null;
  readonly trailingItems: NativeHeaderItems;
  /** The Duo workspace navigator appends a compose group to the detail column's bar. */
  readonly compose: boolean;
}) {
  const itemWidth = (items: NativeHeaderItems) =>
    items.reduce<number>((width, item) => {
      if (
        input.verticalBar &&
        (item.type === "spacing" || (item.icon != null && item.axisBehavior !== "horizontalOnly"))
      )
        return width;
      return width + (item.type === "spacing" ? Number(item.spacing) : 60);
    }, 0);
  const leadingWidth = input.leadingItems
    ? itemWidth(input.leadingItems) + 16
    : input.verticalBar
      ? 16
      : 72;
  const composeWidth = input.compose && !input.verticalBar ? 68 : 0;
  return Math.max(
    44,
    input.paneWidth -
      input.horizontalInsets -
      leadingWidth -
      itemWidth(input.trailingItems) -
      composeWidth -
      16,
  );
}
