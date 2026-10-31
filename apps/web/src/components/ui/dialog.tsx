import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { type ComponentProps, createContext, type ReactNode, use, useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  DIALOG_APP_POPUP_CLASS,
  DIALOG_APP_PANEL_POPUP_CLASS,
  DIALOG_APP_PANEL_BACKDROP_CLASS,
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
}: DialogPrimitive.Backdrop.Props & { variant?: "default" | "media" | "panel" }) {
  return (
    <DialogPrimitive.Backdrop
      forceRender
      className={cn(
        variant === "media"
          ? DIALOG_MEDIA_BACKDROP_CLASS
          : variant === "panel"
            ? DIALOG_APP_PANEL_BACKDROP_CLASS
            : DIALOG_BACKDROP_CLASS,
        className,
      )}
      data-slot="dialog-backdrop"
      {...props}
    />
  );
}

function DialogViewport({
  className,
  variant = "default",
  ...props
}: DialogPrimitive.Viewport.Props & { variant?: "default" | "app" }) {
  return (
    <DialogPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-50 grid justify-items-center",
        variant === "app"
          ? "grid-rows-1 items-center sm:p-6 lg:p-10"
          : "grid-rows-[1fr_auto_1fr] p-4",
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
  viewportProps,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  bottomStickOnMobile?: boolean;
  variant?: "default" | "media" | "app" | "app-panel";
  viewportProps?: Omit<DialogPrimitive.Viewport.Props, "className">;
}) {
  return (
    <DialogPortal>
      {/* Media opens from inside other overlays (a composer chip, a popover), so it sits above them. */}
      <DialogBackdrop
        className={variant === "media" ? "z-[60]" : undefined}
        variant={variant === "media" ? "media" : variant === "app-panel" ? "panel" : "default"}
      />
      <DialogViewport
        variant={variant === "app" || variant === "app-panel" ? "app" : "default"}
        {...viewportProps}
        className={cn(
          variant === "app-panel" && "max-sm:p-2",
          bottomStickOnMobile && "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12",
          variant === "media" &&
            "z-[60] grid-rows-1 place-items-center px-4 pb-6 pt-[calc(var(--native-titlebar-height,0px)+1.5rem)] [-webkit-app-region:no-drag]",
        )}
      >
        <DialogPrimitive.Popup
          className={cn(
            variant === "media"
              ? DIALOG_MEDIA_POPUP_CLASS
              : variant === "app-panel"
                ? DIALOG_APP_PANEL_POPUP_CLASS
                : variant === "app"
                  ? DIALOG_APP_POPUP_CLASS
                  : DIALOG_POPUP_CLASS,
            variant === "app" || variant === "app-panel"
              ? "text-foreground"
              : "row-start-2 text-popover-foreground",
            variant === "default" && "max-h-full max-w-lg",
            bottomStickOnMobile &&
              variant !== "app" &&
              variant !== "app-panel" &&
              DIALOG_MOBILE_SHEET_CLASS,
            className,
          )}
          data-slot="dialog-popup"
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
      </DialogViewport>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-1 px-5 pt-5 pb-4", className)}
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
        "flex flex-col-reverse gap-2 px-5 pb-4 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-pane)-1px)]",
        className,
      )}
      data-slot="dialog-footer"
      data-variant={variant}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn(
        "wrap-anywhere text-label [font-size:0.9375rem] font-semibold text-strong-foreground leading-snug",
        className,
      )}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn(
        "text-body sm:[font-size:0.8125rem] leading-[1.45] text-muted-foreground",
        className,
      )}
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
          "space-y-4 px-5 pt-5 pb-4 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-0",
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
