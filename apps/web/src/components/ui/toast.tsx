import { Spinner } from "~/components/ui/spinner";

import { Toast } from "@base-ui/react/toast";
import {
  useEffect,
  useState,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide";

import { cn } from "~/lib/utils";
import { Button, type ButtonVariant, buttonVariants } from "~/components/ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  buildVisibleToastLayout,
  hasVisibleToastAction,
  shouldHideCollapsedToastContent,
  shouldRenderThreadScopedToast,
} from "./toast.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";
import { useThreadRouteTarget } from "~/hooks/useThreadRouteTarget";

export type ThreadToastData = {
  threadRef?: ScopedThreadRef | null;
  threadId?: ThreadId | null;
  leadingIcon?: ReactNode;
  tooltipStyle?: boolean;
  variant?: "default" | "notification";
  onClose?: (() => void) | undefined;
  dismissAfterVisibleMs?: number;
  hideCopyButton?: boolean;
  additionalActions?: ReadonlyArray<{
    id: string;
    props: ComponentPropsWithoutRef<"button">;
  }>;
  secondaryActionProps?: ComponentPropsWithoutRef<"button">;
  secondaryActionVariant?: ButtonVariant;
  /** Full-width block under the text, such as a command well. */
  body?: ReactNode;
  expandableContent?: ReactNode;
  expandableLabels?: { expand?: string; collapse?: string };
  expandableDescriptionTrigger?: boolean;
  actionVariant?: ButtonVariant;
};

type BaseToastManager = ReturnType<typeof Toast.createToastManager<ThreadToastData>>;
type ToastManagerListener = Parameters<BaseToastManager[" subscribe"]>[0];
type ToastManagerEvent = Parameters<ToastManagerListener>[0];

/**
 * base-ui's manager drops events while no provider is subscribed. App services raise toasts
 * from before the first render (and while the root error view replaces the providers), so hold
 * those until a provider listens.
 */
function createBufferedToastManager(): BaseToastManager {
  const manager = Toast.createToastManager<ThreadToastData>();
  const listeners = new Set<ToastManagerListener>();
  const pending: ToastManagerEvent[] = [];
  manager[" subscribe"]((event) => {
    if (listeners.size === 0) {
      pending.push(event);
      return;
    }
    for (const listener of listeners) listener(event);
  });
  return {
    ...manager,
    " subscribe"(listener) {
      listeners.add(listener);
      for (const event of pending.splice(0)) listener(event);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const toastManager = createBufferedToastManager();
const anchoredToastManager = createBufferedToastManager();
type ToastId = ReturnType<typeof toastManager.add>;
const threadToastVisibleTimeoutRemainingMs = new Map<ToastId, number>();

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: Spinner,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

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

/**
 * Dismiss-only: a round control overlapping the card's top-right corner. The wrappers are
 * flex so the button does not sit on a text line, which would seat it 2px low.
 */
const toastDismissPositionClass = "absolute z-20 -top-1.5 -right-1.5 flex";
const toastDismissButtonClass = cn(
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-xs outline-none",
  "transition-colors hover:text-foreground",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring",
);
// Notices close from inside their head row instead of the corner badge.
// The 12px X's ink sits 7px inside its 20px button: right-1.25 ends the ink on the
// notice's content line (p-3), level with the title's first line.
const noticeDismissPositionClass = "absolute z-20 top-3 right-1.25 flex";
const noticeDismissButtonClass = cn(
  "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none",
  "transition-colors hover:bg-accent hover:text-foreground",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring",
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
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "error-message" });
  const label = isCopied ? "Copied error" : "Copy error";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={label}
            className="[--control-icon-color:currentColor] rounded-md text-muted-foreground/80 hover:bg-transparent hover:text-muted-foreground"
            onClick={() => copyToClipboard(text)}
          />
        }
      >
        <MorphIcon
          className={cn("size-3", isCopied && "text-success")}
          icon={isCopied ? Check : Copy}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

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
        <MorphIcon
          className="size-3.5 shrink-0 opacity-80"
          icon={open ? ChevronUp : ChevronDown}
          strokeWidth={2}
        />
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
    "min-w-0 select-text wrap-break-word text-meta leading-[1.45] text-muted-foreground",
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
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              aria-label={open ? collapseLabel : expandLabel}
              aria-expanded={open}
              className={cn(
                "group flex min-w-0 w-full cursor-pointer select-none items-start gap-1.5 rounded-sm text-left outline-none",
                "transition-colors hover:bg-muted/40",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring",
              )}
              onClick={toggle}
              onKeyDown={onKeyDown}
              role="button"
              tabIndex={0}
            />
          }
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
          <MorphIcon
            aria-hidden
            className="size-3.5 h-lh shrink-0 text-muted-foreground opacity-80"
            icon={open ? ChevronUp : ChevronDown}
            strokeWidth={2}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{open ? collapseLabel : expandLabel}</TooltipPopup>
      </Tooltip>
      {open ? <div className={toastExpandablePanelClassName}>{expandableContent}</div> : null}
    </>
  );
}

type ToastIconComponent = (typeof TOAST_ICONS)[keyof typeof TOAST_ICONS];

interface ToastBodyDescriptor {
  readonly Icon: ToastIconComponent | null | undefined;
  readonly actionVariant: NonNullable<ThreadToastData["actionVariant"]>;
  readonly secondaryActionVariant: NonNullable<ThreadToastData["secondaryActionVariant"]>;
  readonly copyErrorText: string | null;
}

function deriveToastBodyDescriptor(toast: {
  readonly type?: string | undefined;
  readonly description?: unknown;
  readonly data?: ThreadToastData | undefined;
}): ToastBodyDescriptor {
  const Icon = toast.type ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS] : null;
  const actionVariant: NonNullable<ThreadToastData["actionVariant"]> =
    toast.data?.actionVariant ?? "default";
  const secondaryActionVariant: NonNullable<ThreadToastData["secondaryActionVariant"]> =
    toast.data?.secondaryActionVariant ?? "secondary";
  const copyErrorText =
    toast.type === "error" && typeof toast.description === "string" && !toast.data?.hideCopyButton
      ? toast.description
      : null;
  return { Icon, actionVariant, secondaryActionVariant, copyErrorText };
}

/**
 * Toast content. Toasts stack icon, text and actions in one row with the
 * actions under the text; notices put the body and actions full width below.
 */
function toastContentClassName(variant: ThreadToastData["variant"]): string {
  return cn(
    // overflow-x:clip preserves visible vertical overflow; hidden would force overflow-y:auto
    // and clip detail panels.
    "pointer-events-auto flex min-h-0 flex-col overflow-y-visible text-body [overflow-x:clip]",
    variant === "notification" ? "gap-2.5 p-3" : "py-2.5 pr-2.5 pl-3",
  );
}

interface ToastBodyContentProps extends ToastBodyDescriptor {
  readonly actionProps: { readonly children?: ReactNode } | undefined;
  readonly toastData: ThreadToastData | undefined;
  readonly toastDescription: unknown;
  readonly toastType: unknown;
}

function ToastBodyContent({
  Icon,
  copyErrorText,
  actionProps,
  actionVariant,
  secondaryActionVariant,
  toastData,
  toastDescription,
  toastType,
}: ToastBodyContentProps) {
  const additionalActions = toastData?.additionalActions ?? [];
  const secondaryActionProps = toastData?.secondaryActionProps;
  const leadingIcon = toastData?.leadingIcon;
  const body = toastData?.body;
  const isNotification = toastData?.variant === "notification";
  const hasPrimaryAction = hasVisibleToastAction(actionProps);
  const hasActions =
    hasPrimaryAction || additionalActions.length > 0 || secondaryActionProps !== undefined;
  const { className: secondaryActionClassName, ...secondaryActionRest } =
    secondaryActionProps ?? {};

  const actions = hasActions ? (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center",
        isNotification ? "justify-end gap-2" : "gap-1.5 pt-1.5",
      )}
    >
      {additionalActions.map(({ id, props: { className, ...props } }) => (
        <Button
          {...props}
          className={className}
          key={id}
          size="notice"
          type="button"
          variant={secondaryActionVariant}
        />
      ))}
      {secondaryActionProps ? (
        <Button
          {...secondaryActionRest}
          className={secondaryActionClassName}
          size="notice"
          type="button"
          variant={secondaryActionVariant}
        />
      ) : null}
      {hasPrimaryAction ? (
        <Toast.Action
          className={cn(buttonVariants({ size: "notice", variant: actionVariant }), "shrink-0")}
          data-slot="toast-action"
        >
          {actionProps?.children}
        </Toast.Action>
      ) : null}
    </div>
  ) : null;
  const bodyBlock = body ? <div className="min-w-0">{body}</div> : null;

  return (
    <>
      <div className="flex min-w-0 gap-2.5">
        {leadingIcon ? (
          <div
            className="flex h-lh min-w-4 shrink-0 items-center justify-center"
            data-slot="toast-icon"
          >
            {leadingIcon}
          </div>
        ) : Icon ? (
          <div
            className="flex h-lh w-4 shrink-0 items-center justify-center [&>svg]:size-[15px] [&_svg]:pointer-events-none [&_svg]:shrink-0"
            data-slot="toast-icon"
          >
            <Icon className="in-data-[type=error]:text-error-foreground in-data-[type=info]:text-info-foreground in-data-[type=success]:text-success-foreground in-data-[type=warning]:text-warning-foreground in-data-[type=loading]:opacity-80" />
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Padding keeps the title clear of the dismiss control. */}
          <Toast.Title
            className={cn(
              "min-w-0 wrap-break-word text-label [font-size:0.8125rem]",
              isNotification ? "pr-6" : "pr-2",
            )}
            data-slot="toast-title"
          />
          <ToastDescriptionAndExpandable
            toastData={toastData}
            toastDescription={toastDescription}
            toastType={toastType}
          />
          {isNotification ? null : (
            <>
              {bodyBlock ? <div className="pt-1.5">{bodyBlock}</div> : null}
              {actions}
            </>
          )}
        </div>
        {copyErrorText !== null ? (
          <div className="flex h-lh shrink-0 items-center">
            <CopyErrorButton text={copyErrorText} />
          </div>
        ) : null}
      </div>
      {isNotification ? (
        <>
          {bodyBlock}
          {actions}
        </>
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
  const routeTarget = useThreadRouteTarget();
  const activeDraftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );

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
}

function ThreadToastVisibleAutoDismiss({
  toastId,
  dismissAfterVisibleMs,
}: {
  toastId: ToastId;
  dismissAfterVisibleMs: number | undefined;
}) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dismiss timer that pauses on visibilitychange, focus and blur so it only counts visible time
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

function Toasts({ position }: { position: ToastPosition }) {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const activeThreadRef = useActiveThreadRefFromRoute();
  const isTop = position.startsWith("top");
  const visibleToasts = toasts.filter((toast) =>
    shouldRenderThreadScopedToast(toast.data, activeThreadRef),
  );
  const visibleToastLayout = buildVisibleToastLayout(visibleToasts);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prunes the module-level remaining-time map of toasts the manager has dropped
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
          // Above dialogs, sheets and the palette (z-50, media z-60), so an error raised from a dialog can be read and dismissed; under menus and popovers (z-130).
          "fixed z-[70] mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-90 [--toast-inset:--spacing(4)]",
          // From md up the stack's right edge sits under the pane header's last control.
          "md:[--toast-inset:calc(var(--workspace-pane-inset)+var(--workspace-gutter-end))]",
          // Top stacks sit just under the header: the chrome row when the pane
          // is full-bleed, the inset pane's header row from md up.
          "[--toast-header-offset:var(--workspace-topbar-height)] md:[--toast-header-offset:calc(var(--workspace-pane-inset-top)+var(--workspace-pane-header-height))]",
          "data-[position*=top]:top-(--toast-header-offset)",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-(--toast-inset)",
          "data-[position*=center]:-translate-x-1/2 data-[position*=center]:left-1/2",
          // The theme editor docks top-right over the stack (right-5, 21.5rem wide), so the stack steps left of it instead of peeking out from under it.
          "md:data-[position=top-right]:[#root:has([data-theme-editor-panel][data-docked])~[data-slot=toast-portal]_&]:right-96",
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

          return (
            <Toast.Root
              className={cn(
                "surface-popover kbd-in-popover absolute z-[calc(9999-var(--toast-index))] w-full overflow-visible select-none rounded-card text-popover-foreground [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s]",
                // Notices are wider than toasts and grow left from the stack's edge.
                toast.data?.variant === "notification" &&
                  "w-105 max-w-[calc(100vw-var(--toast-inset)*2)] rounded-pane",
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-top",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-bottom",
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                visibleIndex > 0
                  ? "not-data-expanded:[--toast-calc-height:var(--toast-frontmost-height)] data-expanded:[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]"
                  : "[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]",
                "[--toast-gap:--spacing(3)] [--toast-peek:--spacing(3)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.1)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                // Base UI measures with height:auto; --toast-height as min-height would prevent shrinking.
                visibleIndex > 0
                  ? "not-data-expanded:h-(--toast-calc-height) data-expanded:h-auto"
                  : "h-auto",
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-limited:opacity-0",
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                "data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-starting-style:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:opacity-0",
                "data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
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
              <div
                className={
                  toast.data?.variant === "notification"
                    ? noticeDismissPositionClass
                    : toastDismissPositionClass
                }
              >
                <button
                  aria-label="Dismiss notification"
                  className={
                    toast.data?.variant === "notification"
                      ? noticeDismissButtonClass
                      : toastDismissButtonClass
                  }
                  data-slot="toast-close"
                  onClick={() =>
                    handleToastDismissClick(toastManager, toast.id, toast.data?.onClose)
                  }
                  type="button"
                >
                  <XIcon className="size-3" strokeWidth={2} />
                </button>
              </div>
              <Toast.Content
                className={cn(
                  toastContentClassName(toast.data?.variant),
                  "transition-opacity duration-250 data-expanded:opacity-100",
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
                    "relative overflow-visible text-balance text-popover-foreground text-meta transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
                    tooltipStyle
                      ? "surface-tooltip kbd-in-popover rounded-item"
                      : "surface-popover kbd-in-popover rounded-card",
                    toast.data?.variant === "notification" && "rounded-pane",
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
                      <div
                        className={
                          toast.data?.variant === "notification"
                            ? noticeDismissPositionClass
                            : toastDismissPositionClass
                        }
                      >
                        <button
                          aria-label="Dismiss notification"
                          className={
                            toast.data?.variant === "notification"
                              ? noticeDismissButtonClass
                              : toastDismissButtonClass
                          }
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
                          <XIcon className="size-3" strokeWidth={2} />
                        </button>
                      </div>
                      <Toast.Content className={toastContentClassName(toast.data?.variant)}>
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
