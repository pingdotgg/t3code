import type { ComponentProps, ReactNode } from "react";
import { MenuItem } from "../ui/menu";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function PullRequestPermissionButton({
  reason,
  ...props
}: ComponentProps<typeof Button> & { reason?: string | undefined }) {
  return (
    <PullRequestPermissionHint reason={reason}>
      <Button {...props} disabled={props.disabled || Boolean(reason)} />
    </PullRequestPermissionHint>
  );
}

export function PullRequestPermissionHint({
  reason,
  children,
}: {
  reason?: string | undefined;
  children: ReactNode;
}) {
  return reason ? (
    <Tooltip>
      <TooltipTrigger
        render={
          // Focusable so keyboard users can reach the reason; the control keeps its own name.
          <span
            tabIndex={0}
            className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        {children}
        <span className="sr-only">{reason}</span>
      </TooltipTrigger>
      <TooltipPopup>{reason}</TooltipPopup>
    </Tooltip>
  ) : (
    children
  );
}
export function PullRequestPermissionMenuItem({
  reason,
  ...props
}: ComponentProps<typeof MenuItem> & { reason?: string | undefined }) {
  return (
    <PullRequestPermissionHint reason={reason}>
      <MenuItem {...props} disabled={props.disabled || Boolean(reason)} />
    </PullRequestPermissionHint>
  );
}
