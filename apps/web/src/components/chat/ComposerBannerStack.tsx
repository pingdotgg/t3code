import { InfoIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner, type ComposerBannerVariant } from "./ComposerBanner";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

/**
 * Where a notice sits in the stack. The machine comes first, then what needs you; the
 * order is fixed so rows never trade places as notices come and go.
 */
export type ComposerBannerGroup = "environment" | "attention";

export interface ComposerBannerStackItem {
  readonly id: string;
  readonly variant: ComposerBannerVariant;
  readonly textSize?: "compact" | "body";
  readonly group?: ComposerBannerGroup;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly descriptionDetails?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}

const GROUPS = ["environment", "attention"] as const;

const FADE_IN =
  "transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none";

/** Notices about sending from this composer, with machine notices before attention notices. */
export function ComposerBannerStack({
  items,
  detached = false,
}: {
  readonly items: ReadonlyArray<ComposerBannerStackItem>;
  readonly detached?: boolean;
}) {
  const ordered = GROUPS.flatMap((group) =>
    items
      .filter((item) => (item.group ?? "attention") === group)
      .sort(
        (a, b) =>
          (a.variant === "error" ? 0 : a.variant === "warning" ? 1 : 2) -
          (b.variant === "error" ? 0 : b.variant === "warning" ? 1 : 2),
      ),
  );
  if (detached) {
    return ordered.map((item) => (
      <div key={item.id} data-composer-banner-stack="true" className={FADE_IN}>
        <NoticeCard item={item} detached />
      </div>
    ));
  }
  const [first, ...rest] = ordered;
  const overflowLabel = `${rest.length} other ${rest.length === 1 ? "notice" : "notices"}`;
  if (!first) return null;
  return (
    <ComposerBanner.Attachment key={first.id} data-composer-banner-stack="true" className={FADE_IN}>
      <NoticeCard
        item={first}
        overflow={
          rest.length ? (
            <Popover>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <PopoverTrigger
                      render={
                        <Button variant="ghost-muted" size="micro" aria-label={overflowLabel} />
                      }
                    />
                  }
                >
                  +{rest.length}
                </TooltipTrigger>
                <TooltipPopup>{overflowLabel}</TooltipPopup>
              </Tooltip>
              <PopoverPopup side="top" align="end" className="w-[min(40rem,calc(100vw-2rem))]">
                <ComposerBanner.Scroll>
                  {rest.map((item) => (
                    <NoticeCard key={item.id} item={item} detached />
                  ))}
                </ComposerBanner.Scroll>
              </PopoverPopup>
            </Popover>
          ) : null
        }
      />
    </ComposerBanner.Attachment>
  );
}

const SUBPIXEL_ROUNDING = 0.001;

export function NoticeText({
  children,
  className,
  detailsLabel,
  details,
  detailsHeading,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly detailsLabel: string;
  readonly details?: ReactNode;
  readonly detailsHeading?: ReactNode;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const detailsRef = useRef<HTMLButtonElement>(null);
  const [detailsAtWidth, setDetailsAtWidth] = useState<number | null>(null);
  const showDetails = detailsAtWidth !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures text overflow in the DOM via ResizeObserver and MutationObserver to show the details button
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) return;
    const banner = text.closest("[data-slot=composer-banner]");
    const range = document.createRange();
    const measure = () => {
      // Ignore the space taken by the details button itself so it cannot
      // sustain its own overflow after the text would otherwise fit.
      const recoveredWidth = detailsRef.current ? detailsRef.current.offsetWidth + 4 : 0;
      const hidden = getComputedStyle(text).position === "absolute";
      const overflowing =
        hidden ||
        [text, ...text.querySelectorAll("*")].some((element) => {
          // A range spans laid-out content only; scrollWidth also counts positioned layers
          // such as a link's touch hit area, which overflow without cutting any text.
          // The two rects can disagree by float rounding (~0.00001px on phones); real
          // overflow is at least one layout unit, 1/64 of a device pixel.
          range.selectNodeContents(element);
          return (
            range.getBoundingClientRect().width >
            element.getBoundingClientRect().width + recoveredWidth + SUBPIXEL_ROUNDING
          );
        });
      // The button's width can wrap the banner's actions onto a second row, which gives
      // the text room and removes the button, which unwraps the row again. Once shown,
      // the button stays until the banner itself gets wider than where it appeared.
      const width = banner?.clientWidth ?? text.clientWidth;
      setDetailsAtWidth((shownAt) =>
        overflowing
          ? (shownAt ?? width)
          : banner && shownAt !== null && width <= shownAt
            ? shownAt
            : null,
      );
    };
    measure();
    const stopObserving = observeResize([text, banner ?? text], measure);
    let content = text.textContent;
    const mutations = new MutationObserver(() => {
      if (text.textContent !== content) {
        content = text.textContent;
        setDetailsAtWidth(null);
      }
      measure();
    });
    mutations.observe(text, { childList: true, subtree: true, characterData: true });
    return () => {
      stopObserving();
      mutations.disconnect();
    };
  }, []);

  return (
    <span className="contents">
      <span ref={textRef} className={className}>
        {children}
      </span>
      {showDetails || details !== undefined ? (
        <Popover>
          <PopoverTrigger
            openOnHover
            render={
              <Button
                ref={detailsRef}
                data-notice-details=""
                size="icon-xs"
                variant="ghost-muted"
                aria-label={detailsLabel}
                className="flex-none"
              />
            }
          >
            <InfoIcon />
          </PopoverTrigger>
          <PopoverPopup
            aria-label="Notice details"
            tooltipStyle
            side="top"
            className="max-w-[min(30rem,calc(100vw-2rem))] whitespace-normal wrap-anywhere [--inline-button-text-align:start] [--inline-button-white-space:normal] [&_[data-slot=inline-button]]:max-w-full"
          >
            <ComposerBanner.Scroll>
              {detailsHeading}
              {details ?? children}
            </ComposerBanner.Scroll>
          </PopoverPopup>
        </Popover>
      ) : null}
    </span>
  );
}

function NoticeCard({
  item,
  detached = false,
  overflow,
}: {
  readonly overflow?: ReactNode;
  readonly item: ComposerBannerStackItem;
  readonly detached?: boolean;
}) {
  return (
    <ComposerBanner.Root
      role={item.variant === "error" || item.variant === "warning" ? "alert" : undefined}
      variant={item.variant}
      textSize={item.textSize ?? "compact"}
      detached={detached}
      density="comfortable"
      // Body-size titles take an icon as large as the dismiss button's.
      className={
        item.textSize === "body" ? "[--composer-banner-icon-column:--spacing(3.5)]" : undefined
      }
      data-chat-composer-collapsed-controls="true"
    >
      <ComposerBanner.Row layout="wrap-actions">
        {/* Narrow cards stack the title and dismiss over the buttons, and drop the description. */}
        <ComposerBanner.Icon
          className={cn(
            "h-lh @min-[480px]:h-7 @min-[480px]:sm:h-6",
            item.textSize === "body" && "[&>svg]:size-3.5",
          )}
        >
          {item.icon}
        </ComposerBanner.Icon>
        <span className="flex min-w-0 flex-col items-start gap-2 @min-[480px]:flex-row @min-[480px]:flex-wrap @min-[480px]:items-center @min-[480px]:gap-x-2 @min-[480px]:gap-y-1.5">
          <ComposerBanner.Content className="w-full max-w-full @max-[480px]:**:data-notice-details:hidden @min-[480px]:min-h-7 @min-[480px]:w-auto @min-[480px]:grow-999 @min-[480px]:whitespace-nowrap @min-[480px]:sm:min-h-6">
            {item.description ? (
              <>
                <span className="min-w-0 text-foreground @min-[480px]:truncate">{item.title}</span>
                <NoticeText
                  detailsLabel={
                    typeof item.title === "string"
                      ? `Show details: ${item.title}`
                      : "Show notice details"
                  }
                  details={item.descriptionDetails}
                  detailsHeading={<span className="block text-foreground">{item.title}</span>}
                  className="w-0 min-w-0 grow truncate font-medium text-muted-foreground @max-[480px]:sr-only"
                >
                  {item.description}
                </NoticeText>
              </>
            ) : (
              <NoticeText
                detailsLabel={
                  typeof item.title === "string"
                    ? `Show full title: ${item.title}`
                    : "Show title details"
                }
                className="min-w-0 text-foreground @min-[480px]:truncate"
              >
                {item.title}
              </NoticeText>
            )}
          </ComposerBanner.Content>
          {item.actions ? (
            <span className="flex flex-wrap items-center gap-1.5">{item.actions}</span>
          ) : null}
        </span>
        {overflow || item.onDismiss ? (
          <ComposerBanner.Actions className="h-lh flex-nowrap @min-[480px]:h-auto">
            {overflow}
            {item.onDismiss ? (
              <ComposerBanner.Dismiss
                aria-label={item.dismissLabel ?? "Dismiss warning"}
                onClick={item.onDismiss}
              />
            ) : null}
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
      {item.children ? <ComposerBanner.Children>{item.children}</ComposerBanner.Children> : null}
    </ComposerBanner.Root>
  );
}
