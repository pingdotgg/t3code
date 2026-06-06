import type {
  PluginUiAlign,
  PluginUiBadgeTone,
  PluginUiButtonSize,
  PluginUiButtonVariant,
  PluginUiBadgeProps,
  PluginUiButtonProps,
  PluginUiComponents,
  PluginUiDialogProps,
  PluginUiEmptyStateProps,
  PluginUiFieldProps,
  PluginUiGap,
  PluginUiInlineProps,
  PluginUiInputProps,
  PluginUiJustify,
  PluginUiLinkProps,
  PluginUiListProps,
  PluginUiListRowProps,
  PluginUiPageProps,
  PluginUiSectionProps,
  PluginUiSelectProps,
  PluginUiSpinnerProps,
  PluginUiStackProps,
  PluginUiSurfaceProps,
  PluginUiSwitchProps,
  PluginUiTextAreaProps,
  PluginUiTextProps,
  PluginUiToolbarProps,
  PluginUiTextTone,
  PluginUiTextVariant,
} from "@t3tools/plugin-api/ui";
import type { PluginRouteSurface } from "@t3tools/contracts";
import type * as React from "react";

import { Badge as AppBadge } from "../components/ui/badge";
import { Button as AppButton } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Input as AppInput } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { Spinner as AppSpinner } from "../components/ui/spinner";
import { Switch as AppSwitch } from "../components/ui/switch";
import { Textarea as AppTextArea } from "../components/ui/textarea";
import { cn } from "../lib/utils";

const gapClassByName = {
  none: "gap-0",
  xs: "gap-1.5",
  sm: "gap-2",
  md: "gap-3",
  lg: "gap-5",
} satisfies Record<PluginUiGap, string>;

const alignClassByName = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
} satisfies Record<PluginUiAlign, string>;

const inlineAlignClassByName = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
} satisfies Record<Exclude<PluginUiAlign, "stretch">, string>;

const justifyClassByName = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
} satisfies Record<PluginUiJustify, string>;

const buttonVariantByName = {
  primary: "default",
  secondary: "secondary",
  outline: "outline",
  ghost: "ghost",
  danger: "destructive",
} satisfies Record<PluginUiButtonVariant, React.ComponentProps<typeof AppButton>["variant"]>;

const buttonSizeByName = {
  xs: "xs",
  sm: "sm",
  md: "default",
  lg: "lg",
} satisfies Record<PluginUiButtonSize, React.ComponentProps<typeof AppButton>["size"]>;

const badgeVariantByTone = {
  default: "outline",
  muted: "secondary",
  success: "success",
  warning: "warning",
  danger: "error",
  info: "info",
} satisfies Record<PluginUiBadgeTone, React.ComponentProps<typeof AppBadge>["variant"]>;

const textToneClassByName = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  danger: "text-destructive-foreground",
  info: "text-info-foreground",
} satisfies Record<PluginUiTextTone, string>;

const textVariantClassByName = {
  body: "text-sm",
  caption: "text-xs",
  label: "text-xs font-medium uppercase",
  heading: "font-heading text-base font-semibold",
} satisfies Record<PluginUiTextVariant, string>;

function PluginPage({ title, actions, children, style }: PluginUiPageProps) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-5" style={style}>
            {children}
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}

function PluginSettingsPage({ title, actions, children, style }: PluginUiPageProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
        <div className="flex min-h-7 min-w-0 items-center gap-2 sm:min-h-6">
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5" style={style}>
          {children}
        </div>
      </main>
    </div>
  );
}

function PluginToolbar({ children, trailing, style }: PluginUiToolbarProps) {
  return (
    <section
      className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border pb-4"
      style={style}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
      {trailing ? <div className="shrink-0 text-muted-foreground text-xs">{trailing}</div> : null}
    </section>
  );
}

function PluginSection({ title, description, actions, children, style }: PluginUiSectionProps) {
  return (
    <section className="min-w-0" style={style}>
      {title || description || actions ? (
        <div className="mb-2 flex min-w-0 items-end justify-between gap-3">
          <div className="min-w-0">
            {title ? (
              <h2 className="truncate text-muted-foreground text-xs font-semibold uppercase">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="mt-1 text-muted-foreground text-sm">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function PluginSurface({ children, style }: PluginUiSurfaceProps) {
  return (
    <div
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-background"
      style={style}
    >
      {children}
    </div>
  );
}

function PluginStack({ children, gap = "md", align = "stretch", style }: PluginUiStackProps) {
  return (
    <div
      className={cn("flex min-w-0 flex-col", gapClassByName[gap], alignClassByName[align])}
      style={style}
    >
      {children}
    </div>
  );
}

function PluginInline({
  children,
  gap = "sm",
  align = "center",
  justify = "start",
  wrap = true,
  style,
}: PluginUiInlineProps) {
  return (
    <div
      className={cn(
        "flex min-w-0",
        gapClassByName[gap],
        inlineAlignClassByName[align],
        justifyClassByName[justify],
        wrap && "flex-wrap",
      )}
      style={style}
    >
      {children}
    </div>
  );
}

function PluginText({
  children,
  tone = "default",
  variant = "body",
  truncate = false,
  title,
  style,
}: PluginUiTextProps) {
  return (
    <span
      className={cn(
        "min-w-0",
        textToneClassByName[tone],
        textVariantClassByName[variant],
        truncate && "truncate",
      )}
      style={style}
      title={title}
    >
      {children}
    </span>
  );
}

function PluginField({ label, description, children, style }: PluginUiFieldProps) {
  return (
    <div className="grid min-w-0 gap-1.5" style={style}>
      <Label render={<span />}>{label}</Label>
      {children}
      {description ? <span className="text-muted-foreground text-xs">{description}</span> : null}
    </div>
  );
}

function PluginButton({
  children,
  variant = "outline",
  size = "sm",
  disabled,
  title,
  onClick,
  style,
}: PluginUiButtonProps) {
  return (
    <AppButton
      disabled={disabled}
      onClick={onClick}
      size={buttonSizeByName[size]}
      style={style}
      title={title}
      variant={buttonVariantByName[variant]}
    >
      {children}
    </AppButton>
  );
}

function PluginLink({ href, children, title, onClick, style }: PluginUiLinkProps) {
  return (
    <AppButton
      render={
        <a
          href={href}
          onClick={(event) => {
            if (onClick) {
              event.preventDefault();
              onClick();
            }
          }}
        />
      }
      size="xs"
      style={style}
      title={title}
      variant="outline"
    >
      {children}
    </AppButton>
  );
}

function PluginInput({
  value,
  placeholder,
  disabled,
  autoFocus,
  type = "text",
  onValueChange,
}: PluginUiInputProps) {
  return (
    <AppInput
      autoFocus={autoFocus}
      disabled={disabled}
      nativeInput
      onChange={(event) => onValueChange(event.currentTarget.value)}
      placeholder={placeholder}
      type={type}
      value={value}
    />
  );
}

function PluginTextArea({
  value,
  placeholder,
  disabled,
  rows,
  onValueChange,
}: PluginUiTextAreaProps) {
  return (
    <AppTextArea
      disabled={disabled}
      onChange={(event) => onValueChange(event.currentTarget.value)}
      placeholder={placeholder}
      rows={rows}
      value={value}
    />
  );
}

function PluginSelect({
  value,
  placeholder = "Select",
  disabled,
  options,
  onValueChange,
}: PluginUiSelectProps) {
  const items = options.map((option) => ({ label: option.label, value: option.value }));

  return (
    <Select
      disabled={disabled}
      items={items}
      modal={false}
      onValueChange={(nextValue) => {
        if (typeof nextValue === "string") {
          onValueChange(nextValue);
        }
      }}
      value={value}
    >
      <SelectTrigger aria-label={placeholder}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem disabled={option.disabled} key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function PluginSwitch({ checked, disabled, label, onCheckedChange }: PluginUiSwitchProps) {
  const control = (
    <AppSwitch
      checked={checked}
      disabled={disabled}
      onCheckedChange={(nextChecked) => onCheckedChange(Boolean(nextChecked))}
    />
  );

  if (!label) {
    return control;
  }

  return (
    <Label className="justify-start">
      {control}
      {label}
    </Label>
  );
}

function PluginBadge({ children, tone = "default", style }: PluginUiBadgeProps) {
  return (
    <AppBadge size="sm" style={style} variant={badgeVariantByTone[tone]}>
      {children}
    </AppBadge>
  );
}

function PluginDialog({
  open,
  title,
  description,
  children,
  footer,
  onOpenChange,
  style,
}: PluginUiDialogProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-2xl overflow-hidden" style={style}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel className="space-y-4">{children}</DialogPanel>
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogPopup>
    </Dialog>
  );
}

function PluginEmptyState({ title, description, actions }: PluginUiEmptyStateProps) {
  return (
    <Empty className="min-h-36">
      <EmptyHeader>
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {actions ? <EmptyContent>{actions}</EmptyContent> : null}
    </Empty>
  );
}

function PluginList({ children, empty, style }: PluginUiListProps) {
  return (
    <div
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-background"
      style={style}
    >
      {children ?? empty}
    </div>
  );
}

function PluginListRow({ children, actions, style }: PluginUiListRowProps) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-3 border-border border-t p-3 first:border-t-0",
        actions ? "grid-cols-[minmax(0,1fr)_auto] items-center" : "grid-cols-1",
      )}
      style={style}
    >
      <div className="min-w-0">{children}</div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{actions}</div>
      ) : null}
    </div>
  );
}

function PluginSpinner({ label }: PluginUiSpinnerProps) {
  return (
    <span className="inline-flex items-center gap-2 text-muted-foreground text-sm">
      <AppSpinner className="size-4" />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

const basePluginUiComponents = {
  Toolbar: PluginToolbar,
  Section: PluginSection,
  Surface: PluginSurface,
  Stack: PluginStack,
  Inline: PluginInline,
  Text: PluginText,
  Field: PluginField,
  Button: PluginButton,
  Link: PluginLink,
  Input: PluginInput,
  TextArea: PluginTextArea,
  Select: PluginSelect,
  Switch: PluginSwitch,
  Badge: PluginBadge,
  Dialog: PluginDialog,
  EmptyState: PluginEmptyState,
  List: PluginList,
  ListRow: PluginListRow,
  Spinner: PluginSpinner,
} satisfies Omit<PluginUiComponents, "Page">;

export function createPluginUiComponents(surface: PluginRouteSurface): PluginUiComponents {
  return {
    Page: surface === "settings" ? PluginSettingsPage : PluginPage,
    ...basePluginUiComponents,
  };
}

export const pluginUiComponents = createPluginUiComponents("app");
