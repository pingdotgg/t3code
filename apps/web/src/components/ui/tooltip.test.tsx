import { type ComponentProps, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@base-ui/react/tooltip", () => {
  function Positioner({
    children,
    className,
    ...props
  }: ComponentProps<"div"> & { children?: ReactNode }) {
    return (
      <div className={className} {...props}>
        {children}
      </div>
    );
  }

  function Element({ children, ...props }: ComponentProps<"div"> & { children?: ReactNode }) {
    return <div {...props}>{children}</div>;
  }

  return {
    Tooltip: {
      createHandle: () => ({}),
      Provider: Fragment,
      Root: Fragment,
      Trigger: Element,
      Portal: Fragment,
      Positioner,
      Popup: Element,
      Viewport: Element,
    },
  };
});

import { TooltipLayerProvider, TooltipPopup } from "./tooltip";
import { createTooltipScrollDismissController } from "./tooltipScrollDismiss";

function createFakeTooltipTrigger() {
  const ownerDocument = {
    activeElement: null as Element | null,
  };
  const descendants = new Set<Node>();
  const trigger = {
    ownerDocument,
    contains(node: Node | null) {
      return node === trigger || (node !== null && descendants.has(node));
    },
  } as unknown as HTMLElement;

  return { descendants, ownerDocument, trigger };
}

describe("tooltip layering", () => {
  it("keeps global tooltips above dropdowns", () => {
    const html = renderToStaticMarkup(<TooltipPopup>Global tooltip</TooltipPopup>);

    expect(html).toContain("z-[140]");
  });

  it("keeps content tooltips below the chat composer", () => {
    const html = renderToStaticMarkup(
      <TooltipLayerProvider layer="content">
        <TooltipPopup>Timeline tooltip</TooltipPopup>
      </TooltipLayerProvider>,
    );

    expect(html).toContain("z-[15]");
    expect(html).not.toContain("z-[140]");
  });
});

describe("tooltip scroll dismissal", () => {
  it("dismisses the hovered tooltip once when its content scrolls", () => {
    const controller = createTooltipScrollDismissController();
    const { trigger } = createFakeTooltipTrigger();
    const dismiss = vi.fn();

    controller.setHoveredTooltip({ trigger, dismiss });
    controller.dismissHoveredTooltip();
    controller.dismissHoveredTooltip();

    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("keeps a focused tooltip open when its content scrolls", () => {
    const controller = createTooltipScrollDismissController();
    const { ownerDocument, trigger } = createFakeTooltipTrigger();
    const dismiss = vi.fn();
    ownerDocument.activeElement = trigger;

    controller.setHoveredTooltip({ trigger, dismiss });
    controller.dismissHoveredTooltip();

    expect(dismiss).not.toHaveBeenCalled();
  });

  it("keeps a tooltip open when focus is within its trigger", () => {
    const controller = createTooltipScrollDismissController();
    const { descendants, ownerDocument, trigger } = createFakeTooltipTrigger();
    const focusedChild = {} as Element;
    const dismiss = vi.fn();
    descendants.add(focusedChild);
    ownerDocument.activeElement = focusedChild;

    controller.setHoveredTooltip({ trigger, dismiss });
    controller.dismissHoveredTooltip();

    expect(dismiss).not.toHaveBeenCalled();
  });
});
