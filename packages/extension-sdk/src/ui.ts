import type * as React from "react";
import { isComponentType } from "./componentType.js";

export interface UiButtonProps extends React.ComponentPropsWithRef<"button"> {
  readonly variant?: "default" | "ghost" | "ghost-muted" | "outline" | "destructive" | "secondary";
  /** Override the inherited SVG colour without changing the button foreground. */
  readonly iconTone?: "primary";
  readonly size?: "default" | "compact" | "icon-xs" | "icon-sm" | "xs";
}

export interface UiTreeRowProps extends Omit<React.ComponentPropsWithRef<"button">, "children"> {
  readonly path: string;
  readonly depth: number;
  readonly directory: boolean;
  readonly expanded?: boolean;
  readonly selected?: boolean;
  readonly label?: string;
}

export interface UiInputProps extends React.ComponentPropsWithRef<"input"> {
  readonly controlSize?: "default" | "sm";
}

export interface UiInputGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly variant?: "default" | "ghost";
  readonly controlSize?: "default" | "sm";
}

export interface UiMenuPopupProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly align?: "start" | "center" | "end";
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly sideOffset?: number;
  readonly alignOffset?: number;
}

export type UiIconName =
  | "back"
  | "forward"
  | "refresh"
  | "more"
  | "external"
  | "camera"
  | "annotate"
  | "viewport"
  | "minus"
  | "plus"
  | "reset";

export interface ClientUiKit {
  readonly version: number;
  readonly Button: React.ComponentType<UiButtonProps>;
  readonly Input: React.ComponentType<UiInputProps>;
  readonly InputGroup: React.ComponentType<UiInputGroupProps>;
  readonly InputGroupAddon: React.ComponentType<
    React.HTMLAttributes<HTMLDivElement> & {
      readonly align?: "inline-start" | "inline-end";
      readonly revealOnHover?: boolean;
    }
  >;
  readonly Toolbar: React.ComponentType<
    React.HTMLAttributes<HTMLDivElement> & {
      readonly variant?: "chrome" | "group";
    }
  >;
  readonly Menu: React.ComponentType<{
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly children: React.ReactNode;
  }>;
  readonly MenuTrigger: React.ComponentType<
    Omit<React.ComponentPropsWithRef<"button">, "children"> & {
      readonly children: React.ReactElement;
    }
  >;
  readonly MenuPopup: React.ComponentType<UiMenuPopupProps>;
  readonly MenuSub: React.ComponentType<{ readonly children: React.ReactNode }>;
  readonly MenuSubTrigger: React.ComponentType<
    React.HTMLAttributes<HTMLDivElement> & { readonly disabled?: boolean }
  >;
  readonly MenuSubPopup: React.ComponentType<UiMenuPopupProps>;
  readonly MenuGroup: React.ComponentType<React.HTMLAttributes<HTMLDivElement>>;
  readonly MenuRow: React.ComponentType<
    React.HTMLAttributes<HTMLDivElement> & {
      readonly label: string;
      readonly disabled?: boolean;
    }
  >;
  readonly MenuNote: React.ComponentType<
    React.HTMLAttributes<HTMLDivElement> & {
      readonly numeric?: boolean;
    }
  >;
  readonly MenuItem: React.ComponentType<
    React.ComponentPropsWithRef<"div"> & {
      readonly disabled?: boolean;
      readonly closeOnClick?: boolean;
    }
  >;
  readonly MenuSeparator: React.ComponentType<React.HTMLAttributes<HTMLDivElement>>;
  readonly MenuGroupLabel: React.ComponentType<React.HTMLAttributes<HTMLDivElement>>;
  readonly MenuRadioGroup: React.ComponentType<{
    readonly value: string;
    readonly onValueChange: (value: string) => void;
    readonly children: React.ReactNode;
  }>;
  readonly MenuRadioItem: React.ComponentType<{
    readonly value: string;
    readonly disabled?: boolean;
    readonly closeOnClick?: boolean;
    readonly children: React.ReactNode;
  }>;
  readonly TreeRow: React.ComponentType<UiTreeRowProps>;
  readonly Icon: React.ComponentType<{
    readonly name: UiIconName;
    readonly active?: boolean;
    readonly refreshing?: boolean;
    readonly recording?: boolean;
  }>;
}

const COMPONENTS = [
  "Button",
  "Input",
  "InputGroup",
  "InputGroupAddon",
  "Toolbar",
  "MenuRow",
  "MenuNote",
  "MenuGroup",
  "Menu",
  "MenuTrigger",
  "MenuPopup",
  "MenuSub",
  "MenuSubTrigger",
  "MenuSubPopup",
  "MenuItem",
  "MenuSeparator",
  "MenuGroupLabel",
  "MenuRadioGroup",
  "MenuRadioItem",
  "TreeRow",
  "Icon",
] as const;

export function resolveUiKit(
  host: { readonly uiKit?: ClientUiKit },
  minVersion = 1,
): ClientUiKit | null {
  const member: unknown = host.uiKit;
  if (member === null || typeof member !== "object") return null;
  const kit = member as Record<string, unknown>;
  if (!Number.isSafeInteger(minVersion) || minVersion < 1) return null;
  if (!Number.isSafeInteger(kit.version) || (kit.version as number) < minVersion) return null;
  return COMPONENTS.every((name) => isComponentType(kit[name])) ? (member as ClientUiKit) : null;
}
