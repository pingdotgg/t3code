"use client";

import { Toast } from "@base-ui/react/toast";
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useParams } from "@tanstack/react-router";
import { type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { buttonVariants } from "~/components/ui/button";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import {
  buildVisibleToastLayout,
  shouldHideCollapsedToastContent,
  shouldRenderThreadScopedToast,
} from "./toast.logic";

export type ThreadToastData = {
  threadRef?: ScopedThreadRef | null;
  threadId?: ThreadId | null;
  leadingIcon?: ReactNode;
  tooltipStyle?: boolean;
  onClose?: (() => void) | undefined;
  dismissAfterVisibleMs?: number;
  hideCopyButton?: boolean;
  secondaryActionProps?: ComponentPropsWithoutRef<"button">;
  secondaryActionVariant?:
    | "default"
    | "destructive"
    | "destructive-outline"
    | "ghost"
    | "link"
    | "outline"
    | "secondary";
  /** Optional extra body shown after toggling “Show details” (e.g. a list of pending RPCs). */
  expandableContent?: ReactNode;
  expandableLabels?: { expand?: string; collapse?: string };
  /** When set with `expandableContent`, the summary + label act as one text disclosure (no separate chevron row). */
  expandableDescriptionTrigger?: boolean;
  actionLayout?: "inline" | "stacked-end";
  actionVariant?:
    | "default"
    | "destructive"
    | "destructive-outline"
    | "ghost"
    | "link"
    | "outline"
    | "secondary";
};

const toastManager = Toast.createToastManager<ThreadToastData>();
const anchoredToastManager = Toast.createToastManager<ThreadToastData>();
type ToastId = ReturnType<typeof toastManager.add>;
const threadToastVisibleTimeoutRemainingMs = new Map<ToastId, number>();

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: LoaderCircleIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

/** Visually shorten long error bodies; clipboard copy still uses the full `description` string. */
const ERROR_DESCRIPTION_CLAMP_MIN_CHARS = 180;
function errorDescriptionClampClass(type: unknown, description: unknown): string | undefined {
  if (type !== "error" || typeof description !== "string") {
    return undefined;
  }
  if (description.length < ERROR_DESCRIPTION_CLAMP_MIN_CHARS) {
    return undefined;
  }
  return "line-clamp-4";
}

/** Dismiss-only: circular control overlapping the card corner (iOS notification–style). */
const toastCornerDismissClass = "absolute z-20 -top-1.5 -right-1.5";
const toastCornerOrbClass = cn(
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-popover/92 text-muted-foreground shadow-sm outline-none backdrop-blur-sm",
  "transition-[color,background-color,box-shadow] hover:bg-popover hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
);

function handleToastDismissClick(
  manager: typeof toastManager | typeof anchoredToastManager,
  toastId: ToastId,
  onClose: (() => void) | undefined,
) {
  onClose?.();
  manager.close(toastId);
}

function CopyErrorButton({ text }: { text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  return (
    <button
      className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md p-0 text-muted-foreground/80 transition-colors hover:text-muted-foreground"
      onClick={() => copyToClipboard(text)}
      title="Copy error"
      type="button"
    >
      {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </button>
  );
}

/** Scrollable cap for long expandable lists (~10rem); keeps the toast from growing without bound. */
const toastExpandablePanelClassName =
  "mt-2 max-h-40 min-h-0 overflow-y-auto overscroll-contain pr-0.5 select-text";

function ToastExpandableSection({
  children,
  labels,
}: {
  children: ReactNode;
  labels: { expand?: string; collapse?: string };
}) {
  const [open, setOpen] = useState(false);
  const expandLabel = labels.expand ?? "Show details";
  const collapseLabel = labels.collapse ?? "Hide details";

  return (
    <div className="min-w-0">
      <button
        aria-expanded={open}
        className="inline-flex cursor-pointer items-center gap-1 rounded-md py-0.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        {open ? (
          <ChevronUpIcon className="size-3.5 shrink-0 opacity-80" strokeWidth={2.25} />
        ) : (
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-80" strokeWidth={2.25} />
        )}
        {open ? collapseLabel : expandLabel}
      </button>
      {open ? <div className={toastExpandablePanelClassName}>{children}</div> : null}
    </div>
  );
}

function ToastDescriptionAndExpandable({
  toastData,
  toastDescription,
  toastType,
}: {
  toastData: ThreadToastData | undefined;
  toastDescription: unknown;
  toastType: unknown;
}) {
  const expandableContent = toastData?.expandableContent;
  const labels = toastData?.expandableLabels ?? {};
  const descriptionTrigger = toastData?.expandableDescriptionTrigger ?? false;
  const descriptionClassName = cn(
    "min-w-0 select-text wrap-break-word text-muted-foreground",
    errorDescriptionClampClass(toastType, toastDescription),
  );
  const [open, setOpen] = useState(false);

  if (!expandableContent) {
    return <Toast.Description className={descriptionClassName} data-slot="toast-description" />;
  }

  if (!descriptionTrigger) {
    return (
      <>
        <Toast.Description className={descriptionClassName} data-slot="toast-description" />
        <ToastExpandableSection labels={labels}>{expandableContent}</ToastExpandableSection>
      </>
    );
  }

  const expandLabel = labels.expand ?? "Show details";
  const collapseLabel = labels.collapse ?? "Hide details";

  const toggle = () => setOpen((v) => !v);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  };

  return (
    <>
      <div
        aria-expanded={open}
        className={cn(
          "group flex min-w-0 w-full cursor-pointer select-none items-start gap-1.5 rounded-sm text-left outline-none ring-offset-background",
          "transition-colors hover:bg-muted/40",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        )}
        onClick={toggle}
        onKeyDown={onKeyDown}
        role="button"
        tabIndex={0}
        title={open ? collapseLabel : expandLabel}
      >
        <div className="min-w-0 flex-1">
          <Toast.Description
            className={cn(
              "min-w-0 select-none wrap-break-word text-muted-foreground",
              errorDescriptionClampClass(toastType, toastDescription),
              "underline-offset-2 decoration-muted-foreground/60 group-hover:underline",
            )}
            data-slot="toast-description"
          />
        </div>
        {open ? (
          <ChevronUpIcon
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-80"
            strokeWidth={2.25}
          />
        ) : (
          <ChevronDownIcon
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-80"
            strokeWidth={2.25}
          />
        )}
      </div>
      {open ? <div className={toastExpandablePanelClassName}>{expandableContent}</div> : null}
    </>
  );
}

type ToastIconComponent = (typeof TOAST_ICONS)[keyof typeof TOAST_ICONS];

interface ToastBodyDescriptor {
  readonly Icon: ToastIconComponent | null | undefined;
  readonly stackedActionLayout: boolean;
  readonly actionVariant: NonNullable<ThreadToastData["actionVariant"]>;
  readonly secondaryActionVariant: NonNullable<ThreadToastData["secondaryActionVariant"]>;
  readonly copyErrorText: string | null;
  readonly hasTrailingControls: boolean;
  readonly inlineContentEndPad: string;
}

function deriveToastBodyDescriptor(toast: {
  readonly type?: string | undefined;
  readonly description?: unknown;
  readonly actionProps?: unknown;
  readonly data?: ThreadToastData | undefined;
}): ToastBodyDescriptor {
  const Icon = toast.type ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS] : null;
  const stackedActionLayout =
    toast.actionProps !== undefined && toast.data?.actionLayout === "stacked-end";
  const actionVariant: NonNullable<ThreadToastData["actionVariant"]> =
    toast.data?.actionVariant ?? "default";
  const secondaryActionVariant: NonNullable<ThreadToastData["secondaryActionVariant"]> =
    toast.data?.secondaryActionVariant ?? "outline";
  const copyErrorText =
    toast.type === "error" && typeof toast.description === "string" && !toast.data?.hideCopyButton
      ? toast.description
      : null;
  const hasSecondaryAction = toast.data?.secondaryActionProps !== undefined;
  const hasTrailingControls =
    copyErrorText !== null || toast.actionProps !== undefined || hasSecondaryAction;
  const inlineContentEndPad = hasTrailingControls ? "pr-6" : "pr-10";
  return {
    Icon,
    stackedActionLayout,
    actionVariant,
    secondaryActionVariant,
    copyErrorText,
    hasTrailingControls,
    inlineContentEndPad,
  };
}

interface ToastBodyContentProps extends ToastBodyDescriptor {
  readonly actionProps: { readonly children?: ReactNode } | undefined;
  readonly toastData: ThreadToastData | undefined;
  readonly toastDescription: unknown;
  readonly toastType: unknown;
}

function ToastBodyContent({
  stackedActionLayout,
  Icon,
  copyErrorText,
  actionProps,
  actionVariant,
  secondaryActionVariant,
  hasTrailingControls,
  toastData,
  toastDescription,
  toastType,
}: ToastBodyContentProps) {
  const secondaryActionProps = toastData?.secondaryActionProps;
  const leadingIcon = toastData?.leadingIcon;
  const { className: secondaryActionClassName, ...secondaryActionRest } =
    secondaryActionProps ?? {};

  return (
    <>
      <div className={cn("flex min-w-0 gap-2", !stackedActionLayout && "flex-1")}>
        {leadingIcon ? (
          <div
            className="flex h-lh w-4 shrink-0 items-center justify-center"
            data-slot="toast-icon"
          >
            {leadingIcon}
          </div>
        ) : Icon ? (
          <div
            className="[&>svg]:h-lh [&>svg]:w-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
            data-slot="toast-icon"
          >
            <Icon className="in-data-[type=loading]:animate-spin in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning in-data-[type=loading]:opacity-80" />
          </div>
        ) : null}
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col gap-0.5",
            stackedActionLayout && "pr-5",
          )}
        >
          <Toast.Title className="min-w-0 wrap-break-word font-medium" data-slot="toast-title" />
          <ToastDescriptionAndExpandable
            toastData={toastData}
            toastDescription={toastDescription}
            toastType={toastType}
          />
        </div>
      </div>
      {hasTrailingControls ? (
        <div
          className={cn(
            "flex items-center gap-1.5",
            stackedActionLayout ? "w-full justify-end" : "shrink-0",
          )}
        >
          {copyErrorText !== null ? <CopyErrorButton text={copyErrorText} /> : null}
          {secondaryActionProps ? (
            <button
              {...secondaryActionRest}
              className={cn(
                buttonVariants({ size: "xs", variant: secondaryActionVariant }),
                secondaryActionClassName,
              )}
              type="button"
            />
          ) : null}
          {actionProps ? (
            <Toast.Action
              className={cn(buttonVariants({ size: "xs", variant: actionVariant }), "shrink-0")}
              data-slot="toast-action"
            >
              {actionProps.children}
            </Toast.Action>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

interface ToastProviderProps extends Toast.Provider.Props {
  position?: ToastPosition;
}

function useActiveThreadRefFromRoute(): ScopedThreadRef | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const activeDraftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );

  return useMemo(() => {
    if (routeTarget?.kind === "server") {
      return routeTarget.threadRef;
    }
    if (routeTarget?.kind === "draft" && activeDraftSession) {
      return {
        environmentId: activeDraftSession.environmentId,
        threadId: activeDraftSession.threadId,
      };
    }
    return null;
  }, [activeDraftSession, routeTarget]);
}

function ThreadToastVisibleAutoDismiss({
  toastId,
  dismissAfterVisibleMs,
}: {
  toastId: ToastId;
  dismissAfterVisibleMs: number | undefined;
}) {
  useEffect(() => {
    if (!dismissAfterVisibleMs || dismissAfterVisibleMs <= 0) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    let remainingMs = threadToastVisibleTimeoutRemainingMs.get(toastId) ?? dismissAfterVisibleMs;
    let startedAtMs: number | null = null;
    let timeoutId: number | null = null;
    let closed = false;

    const clearTimer = () => {
      if (timeoutId === null) return;
      window.clearTimeout(timeoutId);
      timeoutId = null;
    };

    const closeToast = () => {
      if (closed) return;
      closed = true;
      threadToastVisibleTimeoutRemainingMs.delete(toastId);
      toastManager.close(toastId);
    };

    const pause = () => {
      if (startedAtMs === null) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAtMs));
      startedAtMs = null;
      clearTimer();
      threadToastVisibleTimeoutRemainingMs.set(toastId, remainingMs);
    };

    const start = () => {
      if (closed || startedAtMs !== null) return;
      if (remainingMs <= 0) {
        closeToast();
        return;
      }
      startedAtMs = Date.now();
      clearTimer();
      timeoutId = window.setTimeout(() => {
        remainingMs = 0;
        startedAtMs = null;
        closeToast();
      }, remainingMs);
    };

    const syncTimer = () => {
      const shouldRun = document.visibilityState === "visible" && document.hasFocus();
      if (shouldRun) {
        start();
        return;
      }
      pause();
    };

    syncTimer();
    document.addEventListener("visibilitychange", syncTimer);
    window.addEventListener("focus", syncTimer);
    window.addEventListener("blur", syncTimer);

    return () => {
      document.removeEventListener("visibilitychange", syncTimer);
      window.removeEventListener("focus", syncTimer);
      window.removeEventListener("blur", syncTimer);
      pause();
      clearTimer();
    };
  }, [dismissAfterVisibleMs, toastId]);

  return null;
}

function ToastProvider({ children, position = "top-right", ...props }: ToastProviderProps) {
  return (
    <Toast.Provider toastManager={toastManager} {...props}>
      {children}
      <Toasts position={position} />
    </Toast.Provider>
  );
}

function Toasts({ position = "top-right" }: { position: ToastPosition }) {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const activeThreadRef = useActiveThreadRefFromRoute();
  const isTop = position.startsWith("top");
  const visibleToasts = toasts.filter((toast) =>
    shouldRenderThreadScopedToast(toast.data, activeThreadRef),
  );
  const visibleToastLayout = buildVisibleToastLayout(visibleToasts);

  useEffect(() => {
    const activeToastIds = new Set(toasts.map((toast) => toast.id));
    for (const toastId of threadToastVisibleTimeoutRemainingMs.keys()) {
      if (!activeToastIds.has(toastId)) {
        threadToastVisibleTimeoutRemainingMs.delete(toastId);
      }
    }
  }, [toasts]);

  return (
    <Toast.Portal data-slot="toast-portal">
      <Toast.Viewport
        className={cn(
          "fixed z-100 mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-90 [--toast-header-offset:52px] [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)]",
          // Vertical positioning
          "data-[position*=top]:top-[calc(var(--toast-inset)+var(--toast-header-offset))]",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          // Horizontal positioning
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-(--toast-inset)",
          "data-[position*=center]:-translate-x-1/2 data-[position*=center]:left-1/2",
        )}
        data-position={position}
        data-slot="toast-viewport"
        style={
          {
            "--toast-frontmost-height": `${visibleToastLayout.frontmostHeight}px`,
          } as CSSProperties
        }
      >
        {visibleToastLayout.items.map(({ toast, visibleIndex, offsetY }) => {
          const hideCollapsedContent = shouldHideCollapsedToastContent(
            visibleIndex,
            visibleToastLayout.items.length,
          );
          const bodyDescriptor = deriveToastBodyDescriptor(toast);
          const { stackedActionLayout, inlineContentEndPad } = bodyDescriptor;

          return (
            <Toast.Root
              className={cn(
                "absolute z-[calc(9999-var(--toast-index))] w-full overflow-visible select-none rounded-lg border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
                // Base positioning using data-position
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-top",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-bottom",
                // Gap fill for hover
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                // `--toast-calc-height`: behind + collapsed = peek height only (content `opacity-0`);
                // max(front, own) there produced a tall empty shell for long bodies.
                visibleIndex > 0
                  ? "not-data-expanded:[--toast-calc-height:var(--toast-frontmost-height)] data-expanded:[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]"
                  : "[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]",
                "[--toast-gap:--spacing(3)] [--toast-peek:--spacing(3)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.1)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                // Root height: never `min-h-(--toast-height)` — Base UI measures height by briefly forcing
                // `height: auto` on this node; an old `min-height` from `--toast-height` blocks shrinking,
                // so `recalculateHeight` keeps the inflated value after an expandable closes.
                // Behind + collapsed: fixed peek. Otherwise natural height (expand/collapse, hover stack).
                visibleIndex > 0
                  ? "not-data-expanded:h-(--toast-calc-height) data-expanded:h-auto"
                  : "h-auto",
                // Define offset-y variable
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                // Default state transform
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                // Limited state
                "data-limited:opacity-0",
                // Expanded stack
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                // Starting and ending animations
                "data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-starting-style:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:opacity-0",
                // Ending animations (direction-aware)
                "data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                // Ending animations (expanded)
                "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
              )}
              data-position={position}
              key={toast.id}
              style={
                {
                  "--toast-index": visibleIndex,
                  "--toast-offset-y": `${offsetY}px`,
                } as CSSProperties
              }
              swipeDirection={
                position.includes("center")
                  ? [isTop ? "up" : "down"]
                  : position.includes("left")
                    ? ["left", isTop ? "up" : "down"]
                    : ["right", isTop ? "up" : "down"]
              }
              toast={toast}
            >
              <ThreadToastVisibleAutoDismiss
                dismissAfterVisibleMs={toast.data?.dismissAfterVisibleMs}
                toastId={toast.id}
              />
              <div className={toastCornerDismissClass}>
                <button
                  aria-label="Dismiss notification"
                  className={toastCornerOrbClass}
                  data-slot="toast-close"
                  onClick={() =>
                    handleToastDismissClick(toastManager, toast.id, toast.data?.onClose)
                  }
                  type="button"
                >
                  <XIcon className="size-3" strokeWidth={2.25} />
                </button>
              </div>
              <Toast.Content
                className={cn(
                  // `overflow-x: clip` avoids the CSS quirk where pairing `hidden` + `y: visible`
                  // forces `y` to `auto`. Expandable detail panels can extend below without being cut off.
                  "pointer-events-auto min-h-0 overflow-y-visible pl-3.5 text-sm transition-opacity duration-250 [overflow-x:clip] data-expanded:opacity-100",
                  stackedActionLayout
                    ? "flex flex-col gap-2 py-2.5 pr-3.5"
                    : cn("py-3", "flex items-center justify-between gap-1.5", inlineContentEndPad),
                  hideCollapsedContent &&
                    "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
                )}
              >
                <ToastBodyContent
                  {...bodyDescriptor}
                  actionProps={toast.actionProps}
                  toastData={toast.data}
                  toastDescription={toast.description}
                  toastType={toast.type}
                />
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

function AnchoredToastProvider({ children, ...props }: Toast.Provider.Props) {
  return (
    <Toast.Provider toastManager={anchoredToastManager} {...props}>
      {children}
      <AnchoredToasts />
    </Toast.Provider>
  );
}

function AnchoredToasts() {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const activeThreadRef = useActiveThreadRefFromRoute();

  return (
    <Toast.Portal data-slot="toast-portal-anchored">
      <Toast.Viewport className="outline-none" data-slot="toast-viewport-anchored">
        {toasts
          .filter((toast) => shouldRenderThreadScopedToast(toast.data, activeThreadRef))
          .map((toast) => {
            const tooltipStyle = toast.data?.tooltipStyle ?? false;
            const positionerProps = toast.positionerProps;
            const bodyDescriptor = deriveToastBodyDescriptor(toast);
            const { stackedActionLayout, inlineContentEndPad } = bodyDescriptor;

            if (!positionerProps?.anchor) {
              return null;
            }

            return (
              <Toast.Positioner
                className="z-100 max-w-[min(--spacing(64),var(--available-width))]"
                data-slot="toast-positioner"
                key={toast.id}
                sideOffset={positionerProps.sideOffset ?? 4}
                toast={toast}
              >
                <Toast.Root
                  className={cn(
                    "relative overflow-visible text-balance border bg-popover not-dark:bg-clip-padding text-popover-foreground text-xs transition-[scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
                    tooltipStyle
                      ? "rounded-md shadow-md/5 before:rounded-[calc(var(--radius-md)-1px)]"
                      : "rounded-lg shadow-lg/5 before:rounded-[calc(var(--radius-lg)-1px)]",
                  )}
                  data-slot="toast-popup"
                  toast={toast}
                >
                  {tooltipStyle ? (
                    <Toast.Content className="pointer-events-auto px-2 py-1">
                      <Toast.Title data-slot="toast-title" />
                    </Toast.Content>
                  ) : (
                    <>
                      <div className={toastCornerDismissClass}>
                        <button
                          aria-label="Dismiss notification"
                          className={toastCornerOrbClass}
                          data-slot="toast-close"
                          onClick={() =>
                            handleToastDismissClick(
                              anchoredToastManager,
                              toast.id,
                              toast.data?.onClose,
                            )
                          }
                          type="button"
                        >
                          <XIcon className="size-3" strokeWidth={2.25} />
                        </button>
                      </div>
                      <Toast.Content
                        className={cn(
                          "pointer-events-auto min-h-0 overflow-y-visible pl-3.5 text-sm [overflow-x:clip]",
                          stackedActionLayout
                            ? "flex flex-col gap-2 py-2.5 pr-3.5"
                            : cn(
                                "py-3",
                                "flex items-center justify-between gap-1.5",
                                inlineContentEndPad,
                              ),
                        )}
                      >
                        <ToastBodyContent
                          {...bodyDescriptor}
                          actionProps={toast.actionProps}
                          toastData={toast.data}
                          toastDescription={toast.description}
                          toastType={toast.type}
                        />
                      </Toast.Content>
                    </>
                  )}
                </Toast.Root>
              </Toast.Positioner>
            );
          })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export { stackedThreadToast } from "./toastHelpers";
export type { StackedThreadToastOptions } from "./toastHelpers";

export {
  ToastProvider,
  type ToastPosition,
  toastManager,
  AnchoredToastProvider,
  anchoredToastManager,
};
