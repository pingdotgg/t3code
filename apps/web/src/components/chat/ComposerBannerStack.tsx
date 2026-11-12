import { InfoIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner, type ComposerBannerVariant } from "./ComposerBanner";
import { observeResize } from "~/lib/observeResize";

/**
 * Where a notice sits in the stack. The machine comes first, then what needs you; the
 * order is fixed so rows never trade places as notices come and go.
 */
export type ComposerBannerGroup = "environment" | "attention";

export interface ComposerBannerStackItem {
  readonly id: string;
  readonly variant: ComposerBannerVariant;
  readonly group?: ComposerBannerGroup;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}

const GROUPS = ["environment", "attention"] as const;

const FADE_IN =
  "transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none";

/**
 * Notices about sending from this composer, each its own attached card. Consecutive cards join
 * edge to edge, and the last joins the composer or the drawer below it. Detached cards stand
 * apart instead, for layouts where the composer must not move when a notice appears.
 */
export function ComposerBannerStack({
  items,
  detached = false,
}: {
  readonly items: ReadonlyArray<ComposerBannerStackItem>;
  readonly detached?: boolean;
}) {
  const ordered = GROUPS.flatMap((group) =>
    items.filter((item) => (item.group ?? "attention") === group),
  );
  if (detached) {
    return ordered.map((item) => (
      <div key={item.id} data-composer-banner-stack="true" className={FADE_IN}>
        <NoticeCard item={item} detached />
      </div>
    ));
  }
  return ordered.map((item) => (
    <ComposerBanner.Attachment key={item.id} data-composer-banner-stack="true" className={FADE_IN}>
      <NoticeCard item={item} />
    </ComposerBanner.Attachment>
  ));
}

const SUBPIXEL_ROUNDING = 0.001;

export function NoticeText({
  children,
  className,
  detailsLabel,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly detailsLabel: string;
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
      {showDetails ? (
        <Popover>
          <PopoverTrigger
            openOnHover
            render={
              <Button
                ref={detailsRef}
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
            <ComposerBanner.Scroll>{children}</ComposerBanner.Scroll>
          </PopoverPopup>
        </Popover>
      ) : null}
    </span>
  );
}

function NoticeCard({
  item,
  detached = false,
}: {
  readonly item: ComposerBannerStackItem;
  readonly detached?: boolean;
}) {
  return (
    <ComposerBanner.Root
      role={item.variant === "error" || item.variant === "warning" ? "alert" : undefined}
      variant={item.variant}
      detached={detached}
      density="comfortable"
      data-chat-composer-collapsed-controls="true"
    >
      <ComposerBanner.Row layout="wrap-actions">
        <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
          {item.icon}
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="whitespace-nowrap">
          <NoticeText
            detailsLabel={
              typeof item.title === "string"
                ? `Show full title: ${item.title}`
                : "Show title details"
            }
            className="min-w-0 truncate font-medium leading-7 sm:leading-6"
          >
            {item.title}
          </NoticeText>
          {item.description ? (
            <NoticeText
              detailsLabel={
                typeof item.title === "string"
                  ? `Show details: ${item.title}`
                  : "Show notice details"
              }
              className="w-0 min-w-0 grow truncate text-muted-foreground @max-[400px]:sr-only"
            >
              {item.description}
            </NoticeText>
          ) : null}
        </ComposerBanner.Content>
        {item.actions || item.onDismiss ? (
          <ComposerBanner.Actions className="min-w-14 sm:min-w-12">
            {item.actions}
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
