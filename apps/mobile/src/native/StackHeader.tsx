import {
  NavigationContext,
  NavigationRouteContext,
  type ParamListBase,
} from "@react-navigation/native";
import type {
  NativeStackNavigationOptions,
  NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import { isValidElement, use, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  NativeWorkspaceTabActivityContext,
  WorkspaceSlotOptionsContext,
} from "./v5-workspace-context";
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
  readonly nativeContentInsetHorizontally?: boolean;
  readonly headerTintColor?: string | ColorValue;
  readonly unstable_headerCenterItems?: unknown;
  readonly unstable_headerLeftItems?: unknown;
  readonly unstable_headerRightItems?: unknown;
  readonly unstable_headerSubtitle?: unknown;
  readonly unstable_headerToolbarItems?: unknown;
  readonly unstable_navigationItemStyle?: unknown;
  readonly unstable_headerMinimizationBehavior?: unknown;
};

function useNativeStackNavigation(): NativeStackNavigationProp<ParamListBase> | null {
  const navigation = use(NavigationContext);
  return navigation ? (navigation as NativeStackNavigationProp<ParamListBase>) : null;
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

// React tags elements, component types and contexts with `$$typeof`; their other
// fields are React internals. In development an element's `_owner` is a fiber that
// reaches the whole tree, including contexts that hold their default value outside
// render, and React Navigation's NavigationStateContext default throws when read.
function isReactObject(value: object): boolean {
  return "$$typeof" in value;
}

const identityIds = new WeakMap<object, number>();
let nextIdentityId = 0;

function identitySignature(value: unknown): string {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return String(value);
  }
  let id = identityIds.get(value);
  if (id === undefined) {
    id = nextIdentityId++;
    identityIds.set(value, id);
  }
  return `identity:${id}`;
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
      // Compare factory source; inline references change every render and would loop setOptions.
      return `function:${Function.prototype.toString.call(value)}`;
    case "symbol":
      return `symbol:${String(value)}`;
    case "bigint":
      return `bigint:${String(value)}`;
    case "object": {
      const object = value as object;
      if (isValidElement(object)) {
        // Elements are recreated on every render, so compare what they render.
        return `element:${identitySignature(object.type)}:${String(object.key)}:${optionsSignature(object.props, seen)}`;
      }
      if (isReactObject(object)) return identitySignature(object);
      if (seen.has(object)) return "[circular]";
      seen.add(object);
      if (Array.isArray(value)) {
        return `[${value.map((entry) => optionsSignature(entry, seen)).join(",")}]`;
      }
      // Ignore mutable native refs when comparing static screen options.
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
    if (seen.has(value) || "current" in value || isReactObject(value)) return value;
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

/**
 * Sets the current screen's options. Inside a workspace tab slot they're kept for that slot, so
 * slots rendering the same route never overwrite each other's header.
 */
export function useScreenOptionsWriter() {
  const navigation = useNativeStackNavigation();
  const setSlotOptions = use(WorkspaceSlotOptionsContext)?.set;
  const routeKey = use(NavigationRouteContext)?.key;
  return useMemo(() => {
    if (setSlotOptions && routeKey !== undefined)
      return (options: NativeStackNavigationOptions) => setSlotOptions(routeKey, options);
    return navigation
      ? (options: NativeStackNavigationOptions) => navigation.setOptions(options)
      : null;
  }, [navigation, routeKey, setSlotOptions]);
}

export function NativeStackScreenOptions(props: {
  readonly options?: AppNativeStackNavigationOptions;
  /** Reapply factories when captured data changes; source equality misses asynchronous menu content. */
  readonly optionsVersion?: unknown;
  readonly listeners?: Record<string, (event: never) => void>;
  readonly name?: string;
}) {
  const navigation = useNativeStackNavigation();
  const setOptions = useScreenOptionsWriter();
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const lastAppliedOptionsSignatureRef = useRef<string | undefined>(undefined);
  const latestOptionFunctionsRef = useRef(new Map<string, (...args: unknown[]) => unknown>());
  const optionFunctionWrappersRef = useRef(new Map<string, (...args: unknown[]) => unknown>());

  // Stabilizing records each factory's latest closure, so it runs in the commit
  // phase: a render React discards must not leak its closures into the header.
  // It runs before the tab check so wrappers already installed in an inactive
  // tab's header still call the newest closures.
  useLayoutEffect(() => {
    const normalizedOptions = normalizeScreenOptions(props.options);
    const stableOptions = normalizedOptions
      ? stabilizeOptionFunctions(
          normalizedOptions,
          "options",
          latestOptionFunctionsRef.current,
          optionFunctionWrappersRef.current,
        )
      : undefined;
    if (!tabActive) {
      lastAppliedOptionsSignatureRef.current = undefined;
      return;
    }
    if (!setOptions || !normalizedOptions) {
      return;
    }
    const signature = optionsSignature([stableOptions, props.optionsVersion]);
    if (lastAppliedOptionsSignatureRef.current === signature) {
      return;
    }
    lastAppliedOptionsSignatureRef.current = signature;
    // React Navigation keeps a screen's descriptor while its options are shallowly equal. The
    // stabilized factories keep their identity, so one whose output changed needs a new wrapper
    // to reach the header.
    optionFunctionWrappersRef.current = new Map();
    setOptions(
      stabilizeOptionFunctions(
        normalizedOptions,
        "options",
        latestOptionFunctionsRef.current,
        optionFunctionWrappersRef.current,
      ) as NativeStackNavigationOptions,
    );
  }, [setOptions, props.options, props.optionsVersion, tabActive]);

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
