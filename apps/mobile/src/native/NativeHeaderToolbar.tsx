import { useRoute } from "@react-navigation/native";
import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
  NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import {
  Children,
  isValidElement,
  useLayoutEffect,
  useMemo,
  useRef,
  use,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ColorValue } from "react-native";
import type { HeaderBarButtonSearchBarPlacementItem } from "react-native-screens";
import { NativeWorkspaceTabActivityContext } from "./v5-workspace-context";
import { NativeStackScreenOptions, useScreenOptionsWriter } from "./StackHeader";

function labelFromChildren(children: ReactNode): string {
  const parts: string[] = [];
  Children.forEach(children, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      parts.push(String(child));
    } else if (isValidElement<{ children?: ReactNode }>(child)) {
      parts.push(labelFromChildren(child.props.children));
    }
  });
  return parts.join("");
}

type NativeStackHeaderIcon = NonNullable<
  Extract<NativeStackHeaderItem, { type: "button" }>["icon"]
>;
type NativeStackHeaderAxisBehavior = Extract<
  NativeStackHeaderItem,
  { type: "button" }
>["axisBehavior"];
type NativeStackHeaderVisibilityPriority = Extract<
  NativeStackHeaderItem,
  { type: "button" }
>["visibilityPriority"];
type NativeToolbarItem = NativeStackHeaderItem | HeaderBarButtonSearchBarPlacementItem;
type NativeStackOptionsWithToolbar = NativeStackNavigationOptions & {
  unstable_headerToolbarItems?: () => NativeToolbarItem[];
};

function iconFromProp(icon: unknown): NativeStackHeaderIcon | undefined {
  if (typeof icon === "string") return { type: "sfSymbol", name: icon as never };
  if (
    typeof icon === "object" &&
    icon !== null &&
    "type" in icon &&
    icon.type === "image" &&
    "source" in icon
  ) {
    return icon as NativeStackHeaderIcon;
  }
  return undefined;
}

type RegisterHandler = (handler: unknown) => () => void;

type ToolbarElementProps = Record<string, unknown> & { readonly children?: ReactNode };

function elementTypeName(element: ReactElement): string | undefined {
  const type = element.type;
  if (typeof type === "function") {
    return (type as { displayName?: string; name?: string }).displayName ?? type.name;
  }
  return undefined;
}

function convertMenuAction(
  element: ReactElement<ToolbarElementProps>,
  register: RegisterHandler,
): NativeStackHeaderItemMenu["menu"]["items"][number] | null {
  const typeName = elementTypeName(element);
  if (typeName === "NativeHeaderToolbarMenuAction") {
    const label = labelFromChildren(element.props.children);
    return {
      type: "action",
      label,
      description: typeof element.props.subtitle === "string" ? element.props.subtitle : undefined,
      disabled: Boolean(element.props.disabled),
      icon: iconFromProp(element.props.icon),
      onPress: register(element.props.onPress),
      state: element.props.isOn === true ? "on" : undefined,
      destructive: Boolean(element.props.destructive),
      discoverabilityLabel:
        typeof element.props.discoverabilityLabel === "string"
          ? element.props.discoverabilityLabel
          : undefined,
    };
  }

  if (typeName === "NativeHeaderToolbarMenu") {
    return {
      type: "submenu",
      label:
        typeof element.props.title === "string"
          ? element.props.title
          : labelFromChildren(element.props.children),
      icon: iconFromProp(element.props.icon),
      inline: Boolean(element.props.inline),
      items: collectMenuItems(element.props.children, register),
    };
  }

  return null;
}

function collectMenuItems(
  children: ReactNode,
  register: RegisterHandler,
): NativeStackHeaderItemMenu["menu"]["items"] {
  const items: NativeStackHeaderItemMenu["menu"]["items"] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<ToolbarElementProps>(child)) {
      return;
    }
    const item = convertMenuAction(child, register);
    if (item) {
      items.push(item);
      return;
    }
    items.push(...collectMenuItems(child.props.children, register));
  });
  return items;
}

function convertToolbarChild(
  child: ReactNode,
  register: RegisterHandler,
): NativeToolbarItem | null {
  if (!isValidElement<ToolbarElementProps>(child)) {
    return null;
  }

  const typeName = elementTypeName(child);
  if (typeName === "NativeHeaderToolbarCustom" && isValidElement(child.props.children)) {
    return { type: "custom", element: child.props.children };
  }
  if (typeName === "NativeHeaderToolbarSearchBarSlot") {
    return { type: "searchBarPlacement" };
  }

  if (typeName === "NativeHeaderToolbarButton") {
    return {
      type: "button",
      label:
        typeof child.props.label === "string"
          ? child.props.label
          : String(child.props.accessibilityLabel ?? ""),
      accessibilityLabel:
        typeof child.props.accessibilityLabel === "string"
          ? child.props.accessibilityLabel
          : undefined,
      axisBehavior: child.props.axisBehavior as NativeStackHeaderAxisBehavior,
      disabled: Boolean(child.props.disabled),
      icon: iconFromProp(child.props.icon),
      onPress: register(child.props.onPress),
      sharesBackground: !child.props.separateBackground,
      tintColor: child.props.tintColor as ColorValue | undefined,
      variant:
        child.props.variant === "done" || child.props.variant === "prominent"
          ? child.props.variant
          : "plain",
      identifier: typeof child.props.identifier === "string" ? child.props.identifier : undefined,
      visibilityPriority: child.props.visibilityPriority as NativeStackHeaderVisibilityPriority,
    };
  }

  if (typeName === "NativeHeaderToolbarMenu") {
    return {
      type: "menu",
      label: typeof child.props.title === "string" ? child.props.title : "",
      accessibilityLabel:
        typeof child.props.accessibilityLabel === "string"
          ? child.props.accessibilityLabel
          : undefined,
      disabled: Boolean(child.props.disabled),
      axisBehavior: child.props.axisBehavior as NativeStackHeaderAxisBehavior,
      icon: iconFromProp(child.props.icon),
      menu: {
        title: typeof child.props.title === "string" ? child.props.title : undefined,
        items: collectMenuItems(child.props.children, register),
      },
      sharesBackground: !child.props.separateBackground,
      tintColor: child.props.tintColor as ColorValue | undefined,
      variant:
        child.props.variant === "done" || child.props.variant === "prominent"
          ? child.props.variant
          : "plain",
      identifier: typeof child.props.identifier === "string" ? child.props.identifier : undefined,
    };
  }

  if (typeName === "NativeHeaderToolbarSpacer") {
    return {
      type: "spacing",
      spacing: typeof child.props.width === "number" ? child.props.width : 8,
      flexible: Boolean(child.props.flexible),
    } as NativeStackHeaderItem;
  }

  return null;
}

function collectToolbarItems(children: ReactNode, register: RegisterHandler): NativeToolbarItem[] {
  const items: NativeToolbarItem[] = [];
  Children.forEach(children, (child) => {
    const item = convertToolbarChild(child, register);
    if (item) {
      if (item.type === "spacing") {
        // Native defaults missing spacing-item indices to zero, moving spacers before earlier siblings.
        (item as { index?: number }).index = items.length;
      }
      items.push(item);
    }
  });
  return items;
}

function NativeHeaderToolbarRoot(props: {
  readonly placement?: "left" | "right" | "bottom";
  readonly children?: ReactNode;
}) {
  const setOptions = useScreenOptionsWriter();
  const route = useRoute();
  const tabActivity = use(NativeWorkspaceTabActivityContext);
  const isTabActive = tabActivity?.isActive;
  const committedHandlers = useRef<(() => void)[]>([]);
  const { items, handlers } = useMemo(() => {
    const handlers: (() => void)[] = [];
    const register: RegisterHandler = (handler) => {
      const index = handlers.length;
      handlers.push(typeof handler === "function" ? (handler as () => void) : () => undefined);
      return () => committedHandlers.current[index]?.();
    };
    return { items: collectToolbarItems(props.children, register), handlers };
  }, [props.children, committedHandlers]);
  // Native retains actions when unchanged presentation skips re-registration.
  // Publish only committed handlers; abandoned renders must not replace them.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed toolbar handlers to the ref native actions call; discarded renders must not leak
  useLayoutEffect(() => {
    committedHandlers.current = handlers;
    return () => {
      committedHandlers.current = [];
    };
  }, [handlers, committedHandlers]);
  // UIKit's search placement item belongs to the toolbar, never a header group.
  const headerItems = useMemo(
    () => items.filter((item): item is NativeStackHeaderItem => item.type !== "searchBarPlacement"),
    [items],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears this placement's native header items through the navigator when the toolbar unmounts
  useLayoutEffect(() => {
    if (!setOptions) return;
    return () => {
      if (isTabActive && !isTabActive()) return;
      if (props.placement === "bottom") {
        setOptions({
          unstable_headerToolbarItems: () => [],
        } as NativeStackOptionsWithToolbar);
      } else if (props.placement === "left") {
        setOptions({ unstable_headerLeftItems: () => [] });
      } else {
        setOptions({ unstable_headerRightItems: () => [] });
      }
    };
  }, [setOptions, props.placement, isTabActive]);

  return (
    <NativeStackScreenOptions
      optionsVersion={[items, route.params]}
      options={
        props.placement === "bottom"
          ? { unstable_headerToolbarItems: () => items }
          : props.placement === "left"
            ? { unstable_headerLeftItems: () => headerItems }
            : { unstable_headerRightItems: () => headerItems }
      }
    />
  );
}

function NativeHeaderToolbarButton(_props: {
  readonly accessibilityLabel?: string;
  readonly axisBehavior?: NativeStackHeaderAxisBehavior;
  readonly disabled?: boolean;
  readonly icon?: string | Extract<NativeStackHeaderIcon, { type: "image" }>;
  readonly label?: string;
  readonly onPress?: () => void;
  readonly separateBackground?: boolean;
  readonly tintColor?: ColorValue;
  readonly variant?: "plain" | "done" | "prominent";
  readonly identifier?: string;
  readonly visibilityPriority?: NativeStackHeaderVisibilityPriority;
}) {
  return null;
}
NativeHeaderToolbarButton.displayName = "NativeHeaderToolbarButton";

function NativeHeaderToolbarMenu(_props: {
  readonly accessibilityLabel?: string;
  readonly axisBehavior?: NativeStackHeaderAxisBehavior;
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly identifier?: string;
  readonly inline?: boolean;
  readonly separateBackground?: boolean;
  readonly tintColor?: ColorValue;
  readonly title?: string;
  readonly variant?: "plain" | "done" | "prominent";
}) {
  return null;
}
NativeHeaderToolbarMenu.displayName = "NativeHeaderToolbarMenu";

function NativeHeaderToolbarMenuAction(_props: {
  readonly children?: ReactNode;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly discoverabilityLabel?: string;
  readonly icon?: string;
  readonly isOn?: boolean;
  readonly onPress?: () => void;
  readonly subtitle?: string;
}) {
  return null;
}
NativeHeaderToolbarMenuAction.displayName = "NativeHeaderToolbarMenuAction";

function NativeHeaderToolbarCustom(_props: { readonly children: ReactElement }) {
  return null;
}
NativeHeaderToolbarCustom.displayName = "NativeHeaderToolbarCustom";

function NativeHeaderToolbarLabel(_props: { readonly children?: ReactNode }) {
  return null;
}
NativeHeaderToolbarLabel.displayName = "NativeHeaderToolbarLabel";

function NativeHeaderToolbarSpacer(_props: {
  readonly flexible?: boolean;
  readonly sharesBackground?: boolean;
  readonly width?: number;
}) {
  return null;
}
NativeHeaderToolbarSpacer.displayName = "NativeHeaderToolbarSpacer";

function NativeHeaderToolbarSearchBarSlot() {
  return null;
}
NativeHeaderToolbarSearchBarSlot.displayName = "NativeHeaderToolbarSearchBarSlot";

export const NativeHeaderToolbar = Object.assign(NativeHeaderToolbarRoot, {
  Button: NativeHeaderToolbarButton,
  Custom: NativeHeaderToolbarCustom,
  Label: NativeHeaderToolbarLabel,
  Menu: Object.assign(NativeHeaderToolbarMenu, {
    Action: NativeHeaderToolbarMenuAction,
  }),
  MenuAction: NativeHeaderToolbarMenuAction,
  SearchBarSlot: NativeHeaderToolbarSearchBarSlot,
  Spacer: NativeHeaderToolbarSpacer,
});
