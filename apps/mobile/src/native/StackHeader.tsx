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
  useRef,
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

function optionsSignature(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value);
    case "undefined":
      return "undefined";
    case "function":
      // Header factories are frequently recreated inline. Their source is
      // stable across equivalent renders, while a reference comparison would
      // make navigation.setOptions re-enter the navigator indefinitely.
      return `function:${Function.prototype.toString.call(value)}`;
    case "symbol":
      return `symbol:${String(value)}`;
    case "bigint":
      return `bigint:${String(value)}`;
    case "object": {
      const object = value as object;
      if (seen.has(object)) return "[circular]";
      seen.add(object);
      if (Array.isArray(value)) {
        return `[${value.map((entry) => optionsSignature(entry, seen)).join(",")}]`;
      }
      // React refs carry mutable native instances that must not make static
      // screen options appear different after every render.
      if ("current" in object) return "[ref]";
      return `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${optionsSignature((value as Record<string, unknown>)[key], seen)}`,
        )
        .join(",")}}`;
    }
  }
  return String(value);
}

function stabilizeOptionFunctions(
  value: unknown,
  path: string,
  latestFunctions: Map<string, (...args: unknown[]) => unknown>,
  wrappers: Map<string, (...args: unknown[]) => unknown>,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "function") {
    latestFunctions.set(path, value as (...args: unknown[]) => unknown);
    let wrapper = wrappers.get(path);
    if (!wrapper) {
      wrapper = (...args: unknown[]) => {
        return latestFunctions.get(path)?.(...args);
      };
      wrappers.set(path, wrapper);
    }
    return wrapper;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((entry, index) =>
      stabilizeOptionFunctions(entry, `${path}[${index}]`, latestFunctions, wrappers, seen),
    );
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value) || "current" in value) return value;
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        stabilizeOptionFunctions(entry, `${path}.${key}`, latestFunctions, wrappers, seen),
      ]),
    );
  }
  return value;
}

export function NativeStackScreenOptions(props: {
  readonly options?: AppNativeStackNavigationOptions;
  /**
   * Causes dynamic native header factories to be reapplied when their closed-over
   * menu content changes. Factory functions are intentionally stabilized, so
   * their source alone cannot capture a menu that was initially empty while
   * asynchronous data was loading.
   */
  readonly optionsVersion?: unknown;
  readonly listeners?: Record<string, (event: never) => void>;
  readonly name?: string;
}) {
  const navigation = useNativeStackNavigation();
  const lastAppliedOptionsSignatureRef = useRef<string | undefined>(undefined);
  const latestOptionFunctionsRef = useRef(new Map<string, (...args: unknown[]) => unknown>());
  const optionFunctionWrappersRef = useRef(new Map<string, (...args: unknown[]) => unknown>());
  const normalizedOptions = useMemo(() => normalizeScreenOptions(props.options), [props.options]);
  const stableOptions = normalizedOptions
    ? (stabilizeOptionFunctions(
        normalizedOptions,
        "options",
        latestOptionFunctionsRef.current,
        optionFunctionWrappersRef.current,
      ) as NativeStackNavigationOptions)
    : undefined;

  useLayoutEffect(() => {
    if (!navigation || !stableOptions) {
      return;
    }
    const signature = optionsSignature([stableOptions, props.optionsVersion]);
    // Avoid re-entering navigation state when semantically equal options are
    // reapplied every layout (common when callers pass unstable object literals).
    if (lastAppliedOptionsSignatureRef.current === signature) {
      return;
    }
    lastAppliedOptionsSignatureRef.current = signature;
    navigation.setOptions(stableOptions);
  }, [navigation, props.optionsVersion, stableOptions]);

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
      label: typeof child.props.label === "string" ? child.props.label : "",
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
  readonly label?: string;
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
