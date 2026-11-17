import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, PinIcon, PinOffIcon } from "lucide-react";
import { useRef } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { requestPinnedSelectionReveal, unpinSelection } from "../../pinnedSelectionReveal";
import { pinnedSelectionPreview, type PinnedSelection } from "../../pinnedSelections";
import { useRightPanelStore } from "../../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

const EMPTY_PINS: readonly PinnedSelection[] = [];

export function PinnedSelectionsRow(props: { readonly threadRef: ScopedThreadRef }) {
  const threadKey = scopedThreadKey(props.threadRef);
  const pins = useUiStateStore(
    (state) => state.threadPinnedSelectionsById[threadKey] ?? EMPTY_PINS,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "thread.pinSelection", {
    context: { textSelected: true },
  });
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const listed = [...pins].reverse();

  return (
    <Menu>
      <MenuTrigger
        nativeButton={false}
        render={
          <div
            ref={anchorRef}
            aria-label="Pinned"
            className={cn(
              THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
              "cursor-pointer data-popup-open:bg-black/[0.035] dark:data-popup-open:bg-white/[0.08]",
            )}
          />
        }
      >
        <ThreadDetailsControl
          part="primary"
          panel
          size="xs"
          variant="ghost"
          render={<div />}
          className="pointer-events-none cursor-pointer active:scale-100"
        >
          <PinIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className={cn("ml-0 min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            Pinned
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{pins.length}</span>
        </ThreadDetailsControl>
        <span
          aria-hidden="true"
          className={cn(
            THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
            "group-data-popup-open/details-split:bg-border/65",
          )}
        />
        <ThreadDetailsControl
          aria-hidden="true"
          part="secondary"
          panel
          size="sm"
          variant="ghost"
          render={<div />}
          className="pointer-events-none"
        >
          <ChevronDownIcon aria-hidden="true" className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
        </ThreadDetailsControl>
      </MenuTrigger>
      <MenuPopup align="end" anchor={anchorRef} className="w-(--anchor-width)">
        {listed.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Select text, then right-click Pin{shortcut ? ` or press ${shortcut}` : ""}.
          </p>
        ) : (
          listed.map((pin) => (
            <div key={pin.id} className="flex items-center gap-0.5">
              <MenuItem
                className="min-w-0 flex-1"
                title={pin.text}
                onClick={() => {
                  useRightPanelStore
                    .getState()
                    .setThreadPanelOpen(props.threadRef, "popover", false);
                  requestPinnedSelectionReveal({
                    threadKey,
                    pinId: pin.id,
                    messageId: pin.messageId,
                  });
                }}
              >
                <MenuItemLabel>{pinnedSelectionPreview(pin.text)}</MenuItemLabel>
              </MenuItem>
              <button
                type="button"
                className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Unpin"
                onClick={() => unpinSelection(threadKey, pin.id)}
              >
                <PinOffIcon className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </MenuPopup>
    </Menu>
  );
}
