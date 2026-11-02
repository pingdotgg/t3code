import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, PinIcon, PinOffIcon } from "lucide-react";
import { useState } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { requestPinnedSelectionReveal, unpinSelection } from "../../pinnedSelectionReveal";
import { pinnedSelectionPreview, type PinnedSelection } from "../../pinnedSelections";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";

const EMPTY_PINS: readonly PinnedSelection[] = [];

export function PinnedSelectionsSection(props: { readonly threadRef: ScopedThreadRef }) {
  const threadKey = scopedThreadKey(props.threadRef);
  const pins = useUiStateStore(
    (state) => state.threadPinnedSelectionsById[threadKey] ?? EMPTY_PINS,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "thread.pinSelection", {
    context: { textSelected: true },
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Pinned">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/70 px-3 py-2 text-xs text-muted-foreground">
        <PinIcon className="pinned-selection-badge size-3.5" />
        <span className="font-medium text-foreground">Pinned</span>
        <span className="tabular-nums">{pins.length}</span>
      </div>
      {pins.length === 0 ? (
        <p className="px-3 py-6 text-xs text-muted-foreground">
          Select text in the thread, then right-click and choose Pin
          {shortcut ? `, or press ${shortcut}` : ""}.
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col overflow-auto py-1">
          {pins.map((pin) => {
            const expanded = expandedId === pin.id;
            return (
              <li key={pin.id} className="px-2">
                <div className="flex min-w-0 items-center gap-0.5">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate rounded-sm px-1 py-1 text-left text-xs text-foreground hover:bg-accent"
                    onClick={() =>
                      requestPinnedSelectionReveal({
                        threadKey,
                        pinId: pin.id,
                        messageId: pin.messageId,
                      })
                    }
                  >
                    <span className="pinned-selection-mark me-1.5 inline-block size-1.5 rounded-full align-middle" />
                    {pinnedSelectionPreview(pin.text)}
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded-sm px-1 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-expanded={expanded}
                    aria-label={expanded ? "Collapse pin" : "Expand pin"}
                    onClick={() => setExpandedId((current) => (current === pin.id ? null : pin.id))}
                  >
                    {expanded ? (
                      <ChevronDownIcon className="size-3.5" />
                    ) : (
                      <ChevronRightIcon className="size-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded-sm px-1 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label="Unpin"
                    onClick={() => unpinSelection(threadKey, pin.id)}
                  >
                    <PinOffIcon className="size-3.5" />
                  </button>
                </div>
                {expanded ? (
                  <p className="px-2 pb-2 text-xs whitespace-pre-wrap break-words text-foreground/90">
                    {pin.text}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
