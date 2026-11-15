import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { useLayoutEffect, useRef } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

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
  orientation = "both",
  scrollFade = false,
  scrollFadePadding = true,
  scrollbarGutter = false,
  hideScrollbars = false,
  chainVerticalScroll = false,
  radius = "inherit",
  viewportTabIndex,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  orientation?: "both" | "vertical" | "horizontal";
  scrollFade?: boolean;
  scrollFadePadding?: boolean;
  scrollbarGutter?: boolean;
  hideScrollbars?: boolean;
  chainVerticalScroll?: boolean;
  radius?: "inherit" | "none";
  viewportTabIndex?: number;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const fadeWatch = useRef<{ watched: Element[]; orientation: string; stop: () => void } | null>(
    null,
  );
  // Measuring forces layout, so a render that keeps the same content elements does nothing here;
  // the resize observer reports their growth.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the DOM mask in sync when content resizes without a scroll event
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!scrollFade || !viewport) {
      fadeWatch.current?.stop();
      fadeWatch.current = null;
      return;
    }
    const watched = [viewport, ...viewport.children];
    const current = fadeWatch.current;
    if (
      current?.orientation === orientation &&
      current.watched.length === watched.length &&
      current.watched.every((el, i) => el === watched[i])
    ) {
      return;
    }
    fadeWatch.current?.stop();
    const measureFade = () => {
      const maxX =
        orientation === "vertical" ? 0 : Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const maxY =
        orientation === "horizontal"
          ? 0
          : Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const rtl = getComputedStyle(viewport).direction === "rtl";
      const x = Math.max(0, Math.min(maxX, rtl ? -viewport.scrollLeft : viewport.scrollLeft));
      const y = Math.max(0, Math.min(maxY, viewport.scrollTop));
      for (const [edge, value] of Object.entries({
        "x-start": x,
        "x-end": maxX - x,
        "y-start": y,
        "y-end": maxY - y,
      })) {
        viewport.style.setProperty(`--scroll-area-overflow-${edge}`, `${value}px`);
      }
    };
    measureFade();
    fadeWatch.current = { watched, orientation, stop: observeResize(watched, measureFade) };
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops observing the viewport when the scroll area unmounts
  useLayoutEffect(
    () => () => {
      fadeWatch.current?.stop();
      fadeWatch.current = null;
    },
    [],
  );
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
        ref={scrollFade ? viewportRef : undefined}
        {...(viewportTabIndex === undefined ? {} : { tabIndex: viewportTabIndex })}
        style={
          orientation === "vertical"
            ? { overflowX: "hidden" }
            : orientation === "horizontal"
              ? { overflowY: "hidden" }
              : undefined
        }
        className={cn(
          "h-full max-h-[inherit] overflow-auto overscroll-contain rounded-[inherit] outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-has-overflow-x:overscroll-x-contain",
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
          {orientation !== "horizontal" && <ScrollBar orientation="vertical" />}
          {orientation !== "vertical" && <ScrollBar orientation="horizontal" />}
          {orientation === "both" && <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />}
        </>
      )}
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      className={cn(
        "flex opacity-0 transition-opacity delay-300 data-[orientation=horizontal]:mx-1 data-[orientation=horizontal]:mb-px data-[orientation=horizontal]:h-1.5 data-[orientation=vertical]:my-1 data-[orientation=vertical]:mr-px data-[orientation=vertical]:w-1.5 data-[orientation=horizontal]:flex-col data-hovering:opacity-100 data-scrolling:opacity-100 data-hovering:delay-0 data-scrolling:delay-0 data-hovering:duration-100 data-scrolling:duration-100",
        className,
      )}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        className="relative flex-1 rounded-full bg-[var(--app-scrollbar-thumb)] transition-colors hover:bg-[var(--app-scrollbar-thumb-hover)]"
        data-slot="scroll-area-thumb"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { getVirtualizedScrollFadeClassName, ScrollArea, ScrollBar };
