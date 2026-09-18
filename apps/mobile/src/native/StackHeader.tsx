import { useNavigation, type ParamListBase } from "@react-navigation/native";
import type {
  NativeStackNavigationOptions,
  NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ColorValue } from "react-native";

export { NativeHeaderToolbar } from "./NativeHeaderToolbar";

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
