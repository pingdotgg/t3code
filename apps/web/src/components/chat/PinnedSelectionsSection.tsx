import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, PinIcon, PinOffIcon } from "lucide-react";
import { useState } from "react";

import { requestPinnedSelectionReveal, unpinSelection } from "../../pinnedSelectionReveal";
import { pinnedSelectionPreview, type PinnedSelection } from "../../pinnedSelections";
import { useUiStateStore } from "../../uiStateStore";

const EMPTY_PINS: readonly PinnedSelection[] = [];

export function PinnedSelectionsSection(props: { readonly threadRef: ScopedThreadRef }) {
  const threadKey = scopedThreadKey(props.threadRef);
  const pins = useUiStateStore(
    (state) => state.threadPinnedSelectionsById[threadKey] ?? EMPTY_PINS,
  );
  const [collapsed, setCollapsed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (pins.length === 0) return null;

  return (
    <section className="shrink-0 border-b border-border/70" aria-label="Pinned">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((current) => !current)}
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3.5" />
        ) : (
          <ChevronDownIcon className="size-3.5" />
        )}
        <PinIcon className="pinned-selection-badge size-3.5" />
        <span className="font-medium text-foreground">Pinned</span>
        <span className="tabular-nums">{pins.length}</span>
      </button>
      {collapsed ? null : (
        <ul className="flex flex-col pb-1">
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
