import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useRender } from "@base-ui/react/use-render";
import { XIcon } from "lucide-react";
import { type ComponentProps, createContext, type ReactNode, use, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { Button, type ButtonVariant } from "~/components/ui/button";
import {
  DIALOG_BACKDROP_CLASS,
  DIALOG_MEDIA_BACKDROP_CLASS,
  DIALOG_MEDIA_POPUP_CLASS,
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_POPUP_CLASS,
} from "~/components/ui/dialog-styles";
import { ScrollArea } from "~/components/ui/scroll-area";

const ControlledOpenContext = createContext<boolean | undefined>(undefined);

function RetainedWhileClosed({ open, children }: { open: boolean; children: ReactNode }) {
  const controlledOpen = use(ControlledOpenContext);
  const isOpen = open && controlledOpen !== false;
  const [retained, setRetained] = useState(children);
  if (isOpen && retained !== children) {
    setRetained(children);
  }
  return isOpen ? children : retained;
}

function renderRetainedPopup(props: ComponentProps<"div">, state: { open: boolean }) {
  return (
    <div {...props}>
      <RetainedWhileClosed open={state.open}>{props.children}</RetainedWhileClosed>
    </div>
  );
}

function Dialog<Payload>(props: DialogPrimitive.Root.Props<Payload>) {
  return (
    <ControlledOpenContext value={props.open}>
      <DialogPrimitive.Root {...props} />
    </ControlledOpenContext>
  );
}

function useDialogActionInitialFocus() {
  const popupRef = useRef<HTMLDivElement>(null);
  const initialFocus = (openType: string) => {
    // Match Base UI: touch opens focus the popup to avoid opening the virtual keyboard.
    if (openType === "touch") return popupRef.current;
    return (
      popupRef.current?.querySelector<HTMLElement>(
        '[data-slot="dialog-action"]:not(:disabled):not([aria-disabled="true"])',
      ) ?? true
    );
  };
  return { popupRef, initialFocus };
}

const DialogPortal = DialogPrimitive.Portal;

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogBackdrop({
  className,
  variant = "default",
  ...props
}: DialogPrimitive.Backdrop.Props & { variant?: "default" | "media" }) {
  return (
    <DialogPrimitive.Backdrop
      forceRender
      className={cn(
        variant === "media" ? DIALOG_MEDIA_BACKDROP_CLASS : DIALOG_BACKDROP_CLASS,
        className,
      )}
      data-slot="dialog-backdrop"
      {...props}
    />
  );
}

function DialogViewport({ className, ...props }: DialogPrimitive.Viewport.Props) {
  return (
    <DialogPrimitive.Viewport
      // Electron drag regions ignore z-index, so without no-drag a click over a header drag strip never reaches the page.
      className={cn(
        "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4 [-webkit-app-region:no-drag]",
        className,
      )}
      data-slot="dialog-viewport"
      {...props}
    />
  );
}

function DialogPopup({
  className,
  children,
  showCloseButton = true,
  bottomStickOnMobile = true,
  variant = "default",
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  bottomStickOnMobile?: boolean;
  variant?: "default" | "media";
}) {
  const { popupRef, initialFocus } = useDialogActionInitialFocus();
  const popup = useRender({
    ref: popupRef,
    render: (
      <DialogPrimitive.Popup
        className={cn(
          variant === "media" ? DIALOG_MEDIA_POPUP_CLASS : DIALOG_POPUP_CLASS,
          "row-start-2 text-popover-foreground",
          variant === "default" && "max-h-full max-w-lg",
          bottomStickOnMobile && DIALOG_MOBILE_SHEET_CLASS,
          className,
        )}
        data-slot="dialog-popup"
        initialFocus={initialFocus}
        render={renderRetainedPopup}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute end-2 top-2"
            render={<Button size="icon" variant="ghost" />}
          >
            <XIcon />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    ),
  });
  return (
    <DialogPortal>
      {/* Media opens from inside other overlays (a composer chip, a popover), so it sits above them. */}
      <DialogBackdrop className={variant === "media" ? "z-[60]" : undefined} variant={variant} />
      <DialogViewport
        className={cn(
          bottomStickOnMobile && "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12",
          variant === "media" &&
            "z-[60] grid-rows-1 place-items-center px-4 pb-6 pt-[calc(var(--native-titlebar-height,0px)+1.5rem)]",
        )}
      >
        {popup}
      </DialogViewport>
    </DialogPortal>
  );
}

type DialogActionProps = Omit<React.ComponentProps<typeof Button>, "variant"> & {
  variant?: Exclude<ButtonVariant, `${string}destructive${string}`>;
};

function DialogAction(props: DialogActionProps) {
  return <Button data-slot="dialog-action" {...props} />;
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:pb-4",
        className,
      )}
      data-slot="dialog-header"
      {...props}
    />
  );
}

function DialogFooter({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "bare";
}) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]",
        variant === "default" && "border-t bg-muted/72 py-4",
        variant === "bare" && "py-4",
        className,
      )}
      data-slot="dialog-footer"
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn("wrap-anywhere font-semibold text-xl leading-snug", className)}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

function DialogPanel({
  className,
  scrollFade = true,
  ...props
}: React.ComponentProps<"div"> & { scrollFade?: boolean }) {
  return (
    <ScrollArea scrollFade={scrollFade}>
      <div
        className={cn(
          "space-y-4 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:has([data-slot=dialog-footer]:not(.border-t))]:pb-1",
          className,
        )}
        data-slot="dialog-panel"
        {...props}
      />
    </ScrollArea>
  );
}

export {
  ControlledOpenContext,
  renderRetainedPopup,
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogAction,
  useDialogActionInitialFocus,
  DialogBackdrop,
  DialogBackdrop as DialogOverlay,
  DialogPopup,
  DialogPopup as DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogViewport,
};
