import { useLayoutEffect, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { SideChat } from "./SideChatPanel";

/** Keep composers mounted while the panel closes, changes surface or switches thread. */
export function SideChatPortal({
  target,
  ...props
}: Omit<ComponentProps<typeof SideChat>, "visible"> & { target: HTMLElement | null }) {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "flex min-h-0 flex-1 flex-col";
    return element;
  });
  useLayoutEffect(() => {
    target?.appendChild(host);
    return () => host.remove();
  }, [host, target]);
  return createPortal(<SideChat {...props} visible={target !== null} />, host);
}
