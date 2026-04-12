import { cn } from "~/lib/utils";
import type { DesktopWindowControl, DesktopWindowControlsLayout } from "@t3tools/contracts";
import { LinuxWindowControls } from "./LinuxWindowControls";

export function DesktopChromeOverlay(props: { layout: DesktopWindowControlsLayout }) {
  return (
    <>
      <DesktopChromeOverlayBank actions={props.layout.left} side="left" />
      <DesktopChromeOverlayBank actions={props.layout.right} side="right" />
    </>
  );
}

function DesktopChromeOverlayBank(props: {
  actions: readonly DesktopWindowControl[];
  side: "left" | "right";
}) {
  if (props.actions.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "fixed top-0 z-50 flex h-[var(--desktop-chrome-titlebar-height)] w-fit items-center",
        props.side === "left" ? "left-3" : "right-3",
      )}
    >
      <LinuxWindowControls actions={props.actions} />
    </div>
  );
}
