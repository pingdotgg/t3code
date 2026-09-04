import { InfoIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner, type ComposerBannerVariant } from "./ComposerBanner";

// Match the duration-220 exit transition before removing a dismissed notice.
const DISMISS_TRANSITION_MS = 220;

export interface ComposerBannerStackItem {
  readonly id: string;
  readonly variant: ComposerBannerVariant;
  readonly priority?: "urgent" | "activity" | "notice";
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}

export type ComposerBannerStackContent = Pick<
  ComposerBannerStackItem,
  "id" | "variant" | "priority"
> & { readonly content: ReactNode };

type ComposerBannerStackEntry = ComposerBannerStackItem | ComposerBannerStackContent;

function bannerPriority(item: ComposerBannerStackEntry) {
  if (item.priority === "activity") {
    return 0;
  }
  if (item.priority === "urgent" || item.variant === "error" || item.variant === "warning") {
    return 1;
  }
  return 2;
}

interface ComposerBannerStackProps {
  readonly className?: string;
  readonly items: ReadonlyArray<ComposerBannerStackEntry>;
}

export function ComposerBannerStack({ className, items }: ComposerBannerStackProps) {
  const [stackExpanded, setStackExpanded] = useState(false);
  const noticesRef = useRef<HTMLDivElement>(null);
  const peekRef = useRef<HTMLButtonElement>(null);
  const expandedItemsRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<"peek" | "notice" | null>(null);
  const expandedItemsId = useId();
  const [requestedExitingItemId, setExitingItemId] = useState<string | null>(null);
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitingItemId =
    requestedExitingItemId !== null && items.some((item) => item.id === requestedExitingItemId)
      ? requestedExitingItemId
      : null;

  useEffect(() => {
    return () => {
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (items.length < 2) setStackExpanded(false);
  }, [items.length]);

  useLayoutEffect(() => {
    if (stackExpanded && pendingFocusRef.current === "notice") {
      pendingFocusRef.current = null;
      const firstControl = expandedItemsRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]',
      );
      (firstControl ?? expandedItemsRef.current)?.focus({ preventScroll: true });
    } else if (!stackExpanded && pendingFocusRef.current === "peek") {
      pendingFocusRef.current = null;
      peekRef.current?.focus({ preventScroll: true });
    }
  }, [stackExpanded]);

  if (items.length === 0) {
    return null;
  }

  // Activity stays attached. Urgency and severity only order the notices behind it.
  const orderedItems = items.toSorted((a, b) => bannerPriority(a) - bannerPriority(b));
  const frontItem = orderedItems[0];
  if (!frontItem) {
    return null;
  }
  const stackedItems = orderedItems.slice(1);
  const hasStack = stackedItems.length > 0;
  const showCollapsedStackCap = hasStack && exitingItemId !== frontItem.id;
  const firstStackedItem = stackedItems[0];

  const requestDismiss = (item: ComposerBannerStackEntry) => {
    if (!("onDismiss" in item) || !item.onDismiss || exitingItemId) {
      return;
    }
    setExitingItemId(item.id);
    if (dismissTimeoutRef.current) {
      clearTimeout(dismissTimeoutRef.current);
    }
    dismissTimeoutRef.current = setTimeout(() => {
      dismissTimeoutRef.current = null;
      item.onDismiss?.();
    }, DISMISS_TRANSITION_MS);
  };

  return (
    <ComposerBanner.Attachment
      className={className}
      data-composer-banner-drawer="true"
      data-chat-composer-collapsed-controls="true"
    >
      <div className={cn("relative flex flex-col-reverse", hasStack && stackExpanded && "z-50")}>
        <div
          className={cn(
            "relative z-10 transition-[translate,opacity] duration-220 ease-in",
            exitingItemId === frontItem.id
              ? "pointer-events-none translate-y-16 opacity-0"
              : "opacity-100",
          )}
          onPointerDownCapture={() => {
            setStackExpanded(false);
            const activeElement = document.activeElement;
            if (
              activeElement instanceof HTMLElement &&
              noticesRef.current?.contains(activeElement)
            ) {
              activeElement.blur();
            }
          }}
        >
          <ComposerBannerStackAlert
            item={frontItem}
            attached
            exiting={exitingItemId === frontItem.id}
            onDismissRequest={() => requestDismiss(frontItem)}
          />
        </div>
        {hasStack ? (
          <div
            ref={noticesRef}
            className={cn("relative z-20", stackExpanded && "min-h-3")}
            onPointerEnter={(event) => {
              if (event.pointerType === "touch") return;
              if (document.activeElement === peekRef.current) {
                pendingFocusRef.current = "notice";
              }
              setStackExpanded(true);
            }}
            onPointerLeave={(event) => {
              if (!event.currentTarget.contains(document.activeElement)) setStackExpanded(false);
            }}
            onBlurCapture={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget) &&
                !event.currentTarget.matches(":hover")
              ) {
                setStackExpanded(false);
              }
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !stackExpanded) return;
              event.preventDefault();
              event.stopPropagation();
              pendingFocusRef.current = "peek";
              setStackExpanded(false);
            }}
          >
            {showCollapsedStackCap && firstStackedItem ? (
              <ComposerBanner.Peek
                ref={peekRef}
                variant={firstStackedItem.variant}
                aria-label="Show other notices"
                aria-expanded={stackExpanded}
                aria-controls={expandedItemsId}
                aria-hidden={stackExpanded || undefined}
                tabIndex={stackExpanded ? -1 : 0}
                onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  pendingFocusRef.current = "notice";
                  setStackExpanded(true);
                }}
                className={cn(stackExpanded && "pointer-events-none invisible opacity-0")}
              />
            ) : null}
            <div
              id={expandedItemsId}
              ref={expandedItemsRef}
              role="group"
              aria-label="Other notices"
              tabIndex={-1}
              data-composer-banner-stack-expanded-items="true"
              className={cn(
                "grid transition-[grid-template-rows] duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                stackExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <div
                  className={cn(
                    "transform-gpu space-y-2 pb-2 transition-[opacity,transform] duration-150 ease-out will-change-[opacity,transform]",
                    stackExpanded
                      ? "pointer-events-auto visible translate-y-0 opacity-100"
                      : "pointer-events-none invisible translate-y-1 opacity-0",
                  )}
                >
                  {stackedItems.map((item) => (
                    <div
                      key={item.id}
                      className={cn(
                        "transition-[translate,opacity] duration-220 ease-in",
                        exitingItemId === item.id
                          ? "pointer-events-none translate-y-28 opacity-0"
                          : "opacity-100",
                      )}
                    >
                      <ComposerBannerStackAlert
                        item={item}
                        attached={false}
                        exiting={exitingItemId === item.id}
                        onDismissRequest={() => requestDismiss(item)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </ComposerBanner.Attachment>
  );
}

function ComposerBannerStackAlert({
  item,
  attached,
  exiting,
  onDismissRequest,
}: {
  readonly item: ComposerBannerStackEntry;
  readonly attached: boolean;
  readonly exiting: boolean;
  readonly onDismissRequest: () => void;
}) {
  if ("content" in item) {
    return (
      <ComposerBanner.Root
        density="comfortable"
        placement={attached ? "attached" : "floating"}
        variant={item.variant}
      >
        {item.content}
      </ComposerBanner.Root>
    );
  }
  return (
    <ComposerBanner.Root
      role="alert"
      placement={attached ? "attached" : "floating"}
      variant={item.variant}
      density="comfortable"
    >
      <ComposerBanner.Row layout="wrap-actions-narrow">
        <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
          {item.icon}
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="whitespace-nowrap">
          <span
            className={cn(
              "min-w-0 font-medium leading-7 sm:leading-6",
              typeof item.title === "string" && "truncate",
            )}
          >
            {item.title}
          </span>
          {item.description ? (
            <>
              <span className="min-w-0 shrink-[9999] truncate text-muted-foreground @max-[400px]:sr-only">
                {item.description}
              </span>
              <Popover>
                <PopoverTrigger
                  openOnHover
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Show notice details"
                      className="hidden flex-none text-muted-foreground hover:text-foreground @max-[400px]:inline-flex"
                    />
                  }
                >
                  <InfoIcon className="size-3.5" />
                </PopoverTrigger>
                <PopoverPopup
                  tooltipStyle
                  side="top"
                  className="max-w-72 whitespace-normal text-pretty"
                >
                  {item.description}
                </PopoverPopup>
              </Popover>
            </>
          ) : null}
        </ComposerBanner.Content>
        {item.actions || item.onDismiss ? (
          <ComposerBanner.Actions>
            {item.actions}
            {item.onDismiss ? (
              <ComposerBanner.Dismiss
                aria-label={item.dismissLabel ?? "Dismiss warning"}
                disabled={exiting}
                onClick={onDismissRequest}
              />
            ) : null}
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
      {item.children ? <ComposerBanner.Children>{item.children}</ComposerBanner.Children> : null}
    </ComposerBanner.Root>
  );
}
