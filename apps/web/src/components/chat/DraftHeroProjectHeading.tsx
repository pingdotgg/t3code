import { useGT } from "gt-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { observeResize } from "~/lib/observeResize";

const PROJECT_SLOT = "\uE000";

export function DraftHeroProjectHeading({
  children,
  projectName,
}: {
  children: ReactNode;
  projectName: string;
}) {
  const gt = useGT();
  // One sentence for translators; the layout places the project picker at the placeholder.
  // The flex gap stands in for the space before it; the suffix keeps its own leading space.
  const [before = "", after = ""] = gt("What should we build in {project}?", {
    project: PROJECT_SLOT,
  }).split(PROJECT_SLOT);
  const buildIn = before.trim();
  const buildInSuffix = after.trimEnd();
  const containerRef = useRef<HTMLDivElement>(null);
  const inlineRef = useRef<HTMLSpanElement>(null);
  const [fitsInline, setFitsInline] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the heading against its container via ResizeObserver to choose inline or stacked layout
  useLayoutEffect(() => {
    const container = containerRef.current;
    const inline = inlineRef.current;
    if (!container || !inline) return;

    // Measure the full inline heading independently of its current layout, so
    // moving the name below it cannot make the fit check oscillate.
    const update = () =>
      setFitsInline(
        inline.getBoundingClientRect().width <= container.getBoundingClientRect().width,
      );
    update();
    return observeResize([container, inline], update);
  }, []);

  return (
    <div ref={containerRef} className="group/draft-hero relative w-full" data-inline={fitsInline}>
      <span
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden"
      >
        <span
          ref={inlineRef}
          className="flex w-max items-baseline gap-2 whitespace-nowrap font-display font-normal text-3xl tracking-tight"
        >
          <span>{buildIn}</span>
          <span>
            <span className="font-medium">{projectName}</span>
            {buildInSuffix}
          </span>
        </span>
      </span>
      <h1 className="flex w-full flex-col items-center justify-center gap-2 text-center font-display font-normal text-2xl text-foreground tracking-tight sm:text-3xl lg:group-data-[inline=true]/draft-hero:flex-row">
        <span className="max-w-full lg:group-data-[inline=true]/draft-hero:shrink-0 [@media(max-height:28rem)]:sr-only">
          <span className="lg:group-data-[inline=true]/draft-hero:hidden">
            {gt("What should we build?")}
          </span>
          <span className="hidden lg:group-data-[inline=true]/draft-hero:inline">{buildIn}</span>
        </span>
        <span className="flex min-w-0 max-w-full items-baseline justify-center text-base tracking-normal lg:group-data-[inline=true]/draft-hero:text-3xl lg:group-data-[inline=true]/draft-hero:tracking-tight">
          <span className="min-w-0">{children}</span>
          <span className="hidden shrink-0 whitespace-pre lg:group-data-[inline=true]/draft-hero:inline [@media(max-height:28rem)]:hidden!">
            {buildInSuffix}
          </span>
        </span>
      </h1>
    </div>
  );
}
