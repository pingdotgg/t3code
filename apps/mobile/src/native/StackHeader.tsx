import { useNavigation, type ParamListBase } from "@react-navigation/native";
import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
  NativeStackNavigationOptions,
  NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ColorValue } from "react-native";

export {
  nativeHeaderScrollEdgeEffects,
  nativeTopScrollEdgeEffect,
  type NativeHeaderScrollEdgeEffects,
  type NativeTopScrollEdgeEffect,
} from "./scrollEdgeEffects";

export type AppNativeStackNavigationOptions = Omit<
  NativeStackNavigationOptions,
  "headerTintColor" | "unstable_headerLeftItems" | "unstable_headerRightItems"
> & {
  readonly headerTintColor?: string | ColorValue;
  readonly unstable_headerCenterItems?: unknown;
  readonly unstable_headerLeftItems?: unknown;
  readonly unstable_headerRightItems?: unknown;
  readonly unstable_headerSubtitle?: unknown;
  readonly unstable_headerToolbarItems?: unknown;
  readonly unstable_navigationItemStyle?: unknown;
};

function useNativeStackNavigation(): NativeStackNavigationProp<ParamListBase> | null {
  return useNavigation<NativeStackNavigationProp<ParamListBase>>();
}

function normalizeScreenOptions(
  options: AppNativeStackNavigationOptions | undefined,
): NativeStackNavigationOptions | undefined {
  if (!options) {
    return options;
  }

  const normalized = { ...options } as NativeStackNavigationOptions & {
    unstable_navigationItemStyle?: unknown;
    unstable_headerCenterItems?: unknown;
    unstable_headerSubtitle?: unknown;
    unstable_headerToolbarItems?: unknown;
  };

  if (normalized.headerTintColor !== undefined) {
    normalized.headerTintColor = String(normalized.headerTintColor);
  }

  return normalized as NativeStackNavigationOptions;
}

export function NativeStackScreenOptions(props: {
  readonly options?: AppNativeStackNavigationOptions;
  readonly listeners?: Record<string, (event: never) => void>;
  readonly name?: string;
}) {
  const navigation = useNativeStackNavigation();
  const normalizedOptions = useMemo(() => normalizeScreenOptions(props.options), [props.options]);

  useLayoutEffect(() => {
    if (!navigation || !normalizedOptions) {
      return;
    }
    navigation.setOptions(normalizedOptions);
  }, [navigation, normalizedOptions]);

  useEffect(() => {
    if (!navigation || !props.listeners) {
      return;
    }
    const subscriptions = Object.entries(props.listeners).map(([eventName, listener]) =>
      navigation.addListener(eventName as never, listener as never),
    );
    return () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
    };
  }, [navigation, props.listeners]);

  return null;
}

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
type NativeStackOptionsWithToolbar = NativeStackNavigationOptions & {
  unstable_headerToolbarItems?: () => NativeStackHeaderItem[];
};

function iconFromProp(icon: unknown): NativeStackHeaderIcon | undefined {
  if (typeof icon !== "string") {
    return undefined;
  }
  return { type: "sfSymbol", name: icon as never };
}

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
      onPress:
        typeof element.props.onPress === "function"
          ? (element.props.onPress as () => void)
          : () => undefined,
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
      items: collectMenuItems(element.props.children),
    };
  }

  return null;
}

function collectMenuItems(children: ReactNode): NativeStackHeaderItemMenu["menu"]["items"] {
  const items: NativeStackHeaderItemMenu["menu"]["items"] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<ToolbarElementProps>(child)) {
      return;
    }
    const item = convertMenuAction(child);
    if (item) {
      items.push(item);
      return;
    }
    items.push(...collectMenuItems(child.props.children));
  });
  return items;
}

function convertToolbarChild(child: ReactNode): NativeStackHeaderItem | null {
  if (!isValidElement<ToolbarElementProps>(child)) {
    return null;
  }

  const typeName = elementTypeName(child);
  if (typeName === "NativeHeaderToolbarButton") {
    return {
      type: "button",
      label: "",
      accessibilityLabel:
        typeof child.props.accessibilityLabel === "string"
          ? child.props.accessibilityLabel
          : undefined,
      disabled: Boolean(child.props.disabled),
      icon: iconFromProp(child.props.icon),
      onPress:
        typeof child.props.onPress === "function"
          ? (child.props.onPress as () => void)
          : () => undefined,
      sharesBackground: !child.props.separateBackground,
      tintColor: child.props.tintColor as ColorValue | undefined,
      variant: "plain",
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
      icon: iconFromProp(child.props.icon),
      menu: {
        title: typeof child.props.title === "string" ? child.props.title : undefined,
        items: collectMenuItems(child.props.children),
      },
      sharesBackground: !child.props.separateBackground,
      tintColor: child.props.tintColor as ColorValue | undefined,
      variant: "plain",
    };
  }

  if (typeName === "NativeHeaderToolbarSpacer") {
    return {
      type: "spacing",
      spacing: typeof child.props.width === "number" ? child.props.width : 8,
    };
  }

  return null;
}

function collectToolbarItems(children: ReactNode): NativeStackHeaderItem[] {
  const items: NativeStackHeaderItem[] = [];
  Children.forEach(children, (child) => {
    const item = convertToolbarChild(child);
    if (item) {
      items.push(item);
    }
  });
  return items;
}

function NativeHeaderToolbarRoot(props: {
  readonly placement?: "left" | "right" | "bottom";
  readonly children?: ReactNode;
}) {
  const navigation = useNativeStackNavigation();
  const items = useMemo(() => collectToolbarItems(props.children), [props.children]);

  useEffect(() => {
    if (!navigation) {
      return;
    }
    if (props.placement === "bottom") {
      navigation.setOptions({
        unstable_headerToolbarItems: () => items,
      } as NativeStackOptionsWithToolbar);
      return () => {
        navigation.setOptions({
          unstable_headerToolbarItems: () => [],
        } as NativeStackOptionsWithToolbar);
      };
    }
    if (props.placement === "left") {
      navigation.setOptions({ unstable_headerLeftItems: () => items });
      return () => {
        navigation.setOptions({ unstable_headerLeftItems: () => [] });
      };
    }
    navigation.setOptions({ unstable_headerRightItems: () => items });
    return () => {
      navigation.setOptions({ unstable_headerRightItems: () => [] });
    };
  }, [items, navigation, props.placement]);

  return null;
}

function NativeHeaderToolbarButton(_props: {
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly onPress?: () => void;
  readonly separateBackground?: boolean;
  readonly tintColor?: ColorValue;
}) {
  return null;
}
NativeHeaderToolbarButton.displayName = "NativeHeaderToolbarButton";

function NativeHeaderToolbarMenu(_props: {
  readonly accessibilityLabel?: string;
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly inline?: boolean;
  readonly separateBackground?: boolean;
  readonly tintColor?: ColorValue;
  readonly title?: string;
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

function NativeHeaderToolbarLabel(_props: { readonly children?: ReactNode }) {
  return null;
}
NativeHeaderToolbarLabel.displayName = "NativeHeaderToolbarLabel";

function NativeHeaderToolbarSpacer(_props: {
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
  Label: NativeHeaderToolbarLabel,
  Menu: Object.assign(NativeHeaderToolbarMenu, {
    Action: NativeHeaderToolbarMenuAction,
  }),
  MenuAction: NativeHeaderToolbarMenuAction,
  SearchBarSlot: NativeHeaderToolbarSearchBarSlot,
  Spacer: NativeHeaderToolbarSpacer,
});
