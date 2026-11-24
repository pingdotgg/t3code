import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { createContext, type ComponentProps, useContext } from "react";

import { cn } from "~/lib/utils";

type PanelFrameDensity = "default" | "compact";

const PanelFrameDensityContext = createContext<PanelFrameDensity>("default");

const panelFrameToolbarVariants = cva(
  "flex shrink-0 items-center border-b border-divider surface-card-fill text-muted-foreground",
  {
    compoundVariants: [
      {
        className: "gap-2 px-3 py-2 text-meta",
        density: "default",
        flush: false,
      },
      {
        className: "gap-1.5 px-3 py-1.5 text-caption",
        density: "compact",
        flush: false,
      },
    ],
    defaultVariants: {
      density: "default",
      flush: false,
      rounded: "none",
    },
    variants: {
      density: {
        default: "",
        compact: "",
      },
      flush: {
        true: "gap-0 p-0",
        false: "",
      },
      rounded: {
        none: "",
        top: "rounded-t-row",
      },
    },
  },
);

const panelFrameFooterVariants = cva(
  "flex shrink-0 items-center justify-between gap-2 border-t border-divider text-muted-foreground",
  {
    defaultVariants: {
      density: "default",
    },
    variants: {
      density: {
        default: "px-3 py-2 text-meta",
        compact: "px-3 py-1.5 text-caption",
      },
    },
  },
);

const panelFrameNoticeVariants = cva(
  "shrink-0 border-b border-divider surface-card text-muted-foreground",
  {
    defaultVariants: {
      density: "default",
    },
    variants: {
      density: {
        default: "flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-meta",
        compact: "px-3 py-1.5 text-caption",
      },
    },
  },
);

/** Framed panel container on the card surface with token radius. */
function Root({
  density = "default",
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  density?: PanelFrameDensity;
}) {
  return (
    <PanelFrameDensityContext value={density}>
      <div
        data-slot="panel-frame"
        data-density={density}
        className={cn(
          "flex min-w-0 flex-col overflow-clip rounded-card surface-card text-foreground",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </PanelFrameDensityContext>
  );
}

/** Opaque panel header or toolbar strip separated by a bottom divider hairline. */
function Toolbar({
  density,
  flush,
  rounded,
  className,
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof panelFrameToolbarVariants>) {
  const inheritedDensity = useContext(PanelFrameDensityContext);
  const resolvedDensity = density ?? inheritedDensity;
  const defaultProps = {
    "data-slot": "panel-frame-toolbar",
    className: cn(
      panelFrameToolbarVariants({ density: resolvedDensity, flush, rounded }),
      className,
    ),
  };
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(defaultProps, props),
  });
}

/** Main panel content slot. */
function Body({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="panel-frame-body" className={cn("min-h-0 flex-1", className)} {...props} />
  );
}

/** Panel footer separated by a top divider hairline. */
function Footer({
  density,
  className,
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof panelFrameFooterVariants>) {
  const inheritedDensity = useContext(PanelFrameDensityContext);
  const resolvedDensity = density ?? inheritedDensity;
  const defaultProps = {
    "data-slot": "panel-frame-footer",
    className: cn(panelFrameFooterVariants({ density: resolvedDensity }), className),
  };
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(defaultProps, props),
  });
}

/** Inline notice strip below a panel header, on the card surface with a bottom hairline. */
function Notice({
  density,
  className,
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof panelFrameNoticeVariants>) {
  const inheritedDensity = useContext(PanelFrameDensityContext);
  const resolvedDensity = density ?? inheritedDensity;
  const defaultProps = {
    "data-slot": "panel-frame-notice",
    className: cn(panelFrameNoticeVariants({ density: resolvedDensity }), className),
  };
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(defaultProps, props),
  });
}

export const PanelFrame = {
  Root,
  Toolbar,
  Body,
  Footer,
  Notice,
};
