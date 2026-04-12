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
      className={
        props.side === "left"
          ? "fixed left-3 top-0 z-50 flex h-[52px] w-fit items-center sm:left-5"
          : "fixed right-3 top-0 z-50 flex h-[52px] w-fit items-center sm:right-5"
      }
    >
      <LinuxWindowControls actions={props.actions} />
    </div>
  );
}
