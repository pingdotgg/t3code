import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

import { cn } from "~/lib/utils";

const ScrollAreaContent = ScrollAreaPrimitive.Content;

function getVirtualizedScrollFadeClassName({ top, bottom }: { top: boolean; bottom: boolean }) {
  if (!top && !bottom) return undefined;

  return cn(
    "virtualized-scroll-fade [--fade-size:1.5rem]",
    top &&
      bottom &&
      "[--virtualized-scroll-fade-mask:linear-gradient(to_bottom,transparent,black_var(--fade-size),black_calc(100%-var(--fade-size)),transparent)]",
    top &&
      !bottom &&
      "[--virtualized-scroll-fade-mask:linear-gradient(to_bottom,transparent,black_var(--fade-size))]",
    !top &&
      bottom &&
      "[--virtualized-scroll-fade-mask:linear-gradient(to_bottom,black_calc(100%-var(--fade-size)),transparent)]",
  );
}

function ScrollArea({
  className,
  children,
  scrollFade = false,
  scrollFadePadding = true,
  scrollbarGutter = false,
  scrollbarVariant = "default",
  hideScrollbars = false,
  chainVerticalScroll = false,
  radius = "inherit",
  viewportTabIndex,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  scrollFade?: boolean;
  scrollFadePadding?: boolean;
  scrollbarGutter?: boolean;
  scrollbarVariant?: "default" | "persistent";
  hideScrollbars?: boolean;
  chainVerticalScroll?: boolean;
  radius?: "inherit" | "none";
  viewportTabIndex?: number;
}) {
  return (
    <ScrollAreaPrimitive.Root
      className={cn(
        "relative size-full min-h-0 overflow-hidden",
        radius === "none" ? "rounded-none" : "rounded-[inherit]",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        {...(viewportTabIndex === undefined ? {} : { tabIndex: viewportTabIndex })}
        className={cn(
          "h-full max-h-[inherit] overflow-auto overscroll-contain rounded-[inherit] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-has-overflow-x:overscroll-x-contain",
          chainVerticalScroll && "overscroll-y-auto",
          scrollFade &&
            "mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] focus-visible:mask-none [--fade-size:1.5rem]",
          scrollFade && scrollFadePadding && "scroll-p-[var(--fade-size)]",
          scrollFade && !scrollFadePadding && "has-focus-visible:mask-none",
          scrollbarGutter && "scrollbar-gutter-stable",
          hideScrollbars &&
            "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
        data-slot="scroll-area-viewport"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {!hideScrollbars && (
        <>
          <ScrollBar orientation="vertical" variant={scrollbarVariant} />
          <ScrollBar orientation="horizontal" variant={scrollbarVariant} />
          <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
        </>
      )}
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  variant = "default",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props & {
  variant?: "default" | "persistent";
}) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      className={cn(
        "flex data-[orientation=horizontal]:mx-1 data-[orientation=horizontal]:mb-px data-[orientation=vertical]:my-1 data-[orientation=vertical]:mr-px data-[orientation=horizontal]:flex-col",
        variant === "default"
          ? "opacity-0 transition-opacity delay-300 data-[orientation=horizontal]:h-1.5 data-[orientation=vertical]:w-1.5 data-hovering:opacity-100 data-scrolling:opacity-100 data-hovering:delay-0 data-scrolling:delay-0 data-hovering:duration-100 data-scrolling:duration-100"
          : "rounded-full bg-muted/40 p-0.5 data-[orientation=horizontal]:h-2.5 data-[orientation=vertical]:w-2.5",
        className,
      )}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        className={cn(
          "relative flex-1 rounded-full transition-colors",
          variant === "default"
            ? "bg-[var(--app-scrollbar-thumb)] hover:bg-[var(--app-scrollbar-thumb-hover)]"
            : "bg-muted-foreground/50 hover:bg-muted-foreground/70",
        )}
        data-slot="scroll-area-thumb"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { getVirtualizedScrollFadeClassName, ScrollArea, ScrollAreaContent, ScrollBar };
