import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

function createHost() {
  const host = document.createElement("div");
  host.className = "absolute inset-0 flex min-h-0 min-w-0 flex-col";
  return host;
}

/**
 * Renders into an element of its own and moves that element between group slots, so dragging a
 * tab re-parents its DOM instead of remounting a terminal or an editor with unsaved text.
 */
export function DockHostPortal(props: {
  readonly slot: HTMLElement | null;
  readonly children: ReactNode;
}) {
  const { slot, children } = props;
  const [host] = useState(createHost);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the host element into the slot of the group that owns this tab
  useLayoutEffect(() => {
    if (!slot) return;
    slot.appendChild(host);
    return () => host.remove();
  }, [host, slot]);
  return createPortal(children, host);
}
