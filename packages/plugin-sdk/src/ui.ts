import type { ComponentPropsWithoutRef, ReactNode } from "react";

/**
 * T3's own UI components. These exist only at runtime inside T3: build with
 * `@t3tools/plugin-sdk/vite`, which points this module at the app's copies.
 *
 * Each takes the HTML attributes of the element it draws plus its own props, and nothing else, so
 * a misspelled prop fails to typecheck. `data-*` and `aria-*` attributes are always allowed.
 */
type UiComponent<
  Element extends "button" | "div" | "input" | "label" | "p" | "span" | "textarea",
  Props = object,
> = (props: Omit<ComponentPropsWithoutRef<Element>, keyof Props> & Props) => ReactNode;

export declare const Badge: UiComponent<
  "span",
  {
    readonly variant?:
      | "default"
      | "destructive"
      | "error"
      | "info"
      | "outline"
      | "secondary"
      | "success"
      | "warning";
    readonly size?: "default" | "sm" | "lg";
  }
>;
export declare const Button: UiComponent<
  "button",
  {
    readonly variant?:
      | "default"
      | "destructive"
      | "destructive-outline"
      | "ghost"
      | "ghost-muted"
      | "ghost-destructive"
      | "link"
      | "outline"
      | "secondary"
      | "warning-outline";
    readonly size?:
      | "default"
      | "xs"
      | "sm"
      | "lg"
      | "xl"
      | "icon-xs"
      | "icon-sm"
      | "icon"
      | "icon-lg"
      | "icon-xl";
  }
>;
export declare const Empty: UiComponent<"div">;
export declare const EmptyContent: UiComponent<"div">;
export declare const EmptyDescription: UiComponent<"p">;
export declare const EmptyHeader: UiComponent<"div">;
export declare const EmptyMedia: UiComponent<"div", { readonly variant?: "default" | "icon" }>;
export declare const EmptyTitle: UiComponent<"div">;
// T3's Input and Textarea have their own `size`, which the SDK doesn't offer.
export declare const Input: UiComponent<"input", { readonly size?: never }>;
export declare const Label: UiComponent<"label">;
export declare const Switch: UiComponent<
  "span",
  {
    readonly checked?: boolean;
    readonly defaultChecked?: boolean;
    readonly onCheckedChange?: (checked: boolean) => void;
    readonly disabled?: boolean;
    readonly readOnly?: boolean;
    readonly required?: boolean;
    readonly name?: string;
    readonly onChange?: never;
  }
>;
export declare const Textarea: UiComponent<"textarea", { readonly size?: never }>;
