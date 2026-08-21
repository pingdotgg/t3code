type HoveredTooltip = {
  trigger: HTMLElement;
  dismiss: () => void;
};

type TooltipScrollDismissController = {
  setHoveredTooltip: (tooltip: HoveredTooltip | null) => void;
  dismissHoveredTooltip: () => void;
};

function createTooltipScrollDismissController(): TooltipScrollDismissController {
  let hoveredTooltip: HoveredTooltip | null = null;

  return {
    setHoveredTooltip(tooltip) {
      hoveredTooltip = tooltip;
    },
    dismissHoveredTooltip() {
      const tooltip = hoveredTooltip;

      if (
        tooltip === null ||
        tooltip.trigger.contains(tooltip.trigger.ownerDocument.activeElement)
      ) {
        return;
      }

      hoveredTooltip = null;
      tooltip.dismiss();
    },
  };
}

export { createTooltipScrollDismissController, type HoveredTooltip };
