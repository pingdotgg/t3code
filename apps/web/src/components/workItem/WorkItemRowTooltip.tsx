import { cloneElement, createContext, use, type ReactElement, type ReactNode } from "react";

import { Tooltip, TooltipTrigger } from "../ui/tooltip";

/**
 * False inside a list row the pointer has not entered yet. A tooltip costs its row about a
 * hundred hooks, and a windowed list mounts rows as they scroll in, so a row's tooltips mount
 * when the pointer reaches the row, before it reaches a trigger. Everywhere else they mount with
 * their trigger.
 */
export const RowTooltipsContext = createContext(true);

/**
 * A tooltip on an element that never takes focus. Before its row is pointed at, only the
 * element renders, with the same props.
 */
export function RowTooltip({
  render,
  children,
  popup,
  ...triggerProps
}: {
  render: ReactElement<Record<string, unknown>>;
  children?: ReactNode;
  /** The TooltipPopup, or null for none yet. */
  popup: ReactNode;
  onPointerEnter?: () => void;
  onFocus?: () => void;
}) {
  if (!use(RowTooltipsContext)) {
    return children === undefined
      ? cloneElement(render, triggerProps)
      : cloneElement(render, triggerProps, children);
  }
  return (
    <Tooltip>
      <TooltipTrigger render={render} {...triggerProps}>
        {children}
      </TooltipTrigger>
      {popup}
    </Tooltip>
  );
}
