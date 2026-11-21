import type { PluginManifest } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m } from "../i18n/messages";
import type { NativePluginDefinition, NativePluginHost } from "./sdk";

interface NativeView {
  readonly type: string;
  readonly slot?: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly children?: unknown;
  readonly command?: { readonly method: string; readonly input?: unknown; readonly event?: string };
}

interface NativeDocument {
  readonly apiVersion: 1;
  readonly contributions: readonly {
    readonly slot: string;
    readonly id?: string;
    readonly order?: number;
    readonly view: NativeView;
  }[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const safeKey = (key: string) => !["__proto__", "prototype", "constructor"].includes(key);

function bind(value: unknown, props: object, depth = 0): unknown {
  if (depth > 32) throw new Error("Native plugin binding exceeds the depth limit.");
  if (Array.isArray(value)) return value.map((entry) => bind(entry, props, depth + 1));
  if (!record(value)) return value;
  if (typeof value.$prop === "string") {
    let current: unknown = props;
    for (const key of value.$prop.split(".")) {
      if (!safeKey(key) || (!record(current) && !Array.isArray(current))) return undefined;
      current = (current as Readonly<Record<string, unknown>>)[key];
    }
    return current;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => safeKey(key))
      .map(([key, entry]) => [key, bind(entry, props, depth + 1)]),
  );
}

/** JSON describes native views and bound actions; downloaded executable code is never evaluated. */
export function defineDeclarativeNativePlugin(
  manifest: PluginManifest,
  input: unknown,
): NativePluginDefinition {
  let count = 0;
  function validateChildren(value: unknown, depth: number): void {
    if (depth > 32) throw new Error("Native plugin children exceed the depth limit.");
    if (
      value === undefined ||
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return;
    if (Array.isArray(value)) {
      for (const child of value) validateChildren(child, depth + 1);
    } else if (record(value) && "type" in value) {
      validateView(value, depth);
    } else if (!record(value) || typeof value.$prop !== "string" || !value.$prop.trim()) {
      throw new Error("Native children must be text, prop references or views.");
    }
  }
  function validateView(value: unknown, depth: number): void {
    if (++count > 1000 || depth > 32 || !record(value) || typeof value.type !== "string")
      throw new Error("Invalid or oversized native plugin view.");
    if (
      ![
        "builtin",
        "view",
        "text",
        "image",
        "scroll-view",
        "button",
        "pressable",
        "fragment",
      ].includes(value.type)
    )
      throw new Error(`Unknown native plugin view '${value.type}'.`);
    if (value.props !== undefined && !record(value.props))
      throw new Error("Native view props must be an object.");
    if (value.slot !== undefined && (typeof value.slot !== "string" || !value.slot.trim()))
      throw new Error("Native builtin slot must be a nonempty string.");
    if (
      value.command !== undefined &&
      (!record(value.command) ||
        typeof value.command.method !== "string" ||
        !value.command.method.trim() ||
        (value.command.event !== undefined &&
          (typeof value.command.event !== "string" ||
            !value.command.event.trim() ||
            !safeKey(value.command.event))))
    )
      throw new Error("Native command must declare a method and a valid optional event.");
    validateChildren(value.children, depth + 1);
  }
  if (
    !record(input) ||
    input.apiVersion !== 1 ||
    !Array.isArray(input.contributions) ||
    input.contributions.length > 256
  )
    throw new Error("Invalid native plugin document.");
  for (const contribution of input.contributions) {
    if (
      !record(contribution) ||
      typeof contribution.slot !== "string" ||
      !contribution.slot.trim() ||
      (contribution.id !== undefined && typeof contribution.id !== "string") ||
      (contribution.order !== undefined &&
        (typeof contribution.order !== "number" || !Number.isFinite(contribution.order)))
    )
      throw new Error("Invalid native plugin contribution.");
    validateView(contribution.view, 0);
  }
  const document = input as unknown as NativeDocument;
  function render(
    host: NativePluginHost,
    view: NativeView,
    originalProps: object,
    targetSlot: string,
    key?: number,
  ): import("react").ReactNode {
    const { React, ReactNative } = host;
    const primitives = {
      view: ReactNative.View,
      text: ReactNative.Text,
      image: ReactNative.Image,
      "scroll-view": ReactNative.ScrollView,
      pressable: ReactNative.Pressable,
      fragment: React.Fragment,
    };
    const component =
      view.type === "builtin"
        ? host.getBuiltin(view.slot ?? targetSlot)
        : view.type === "button"
          ? host.getBuiltin("native.components.ui.button")
          : primitives[view.type as keyof typeof primitives];
    if (!component) throw new Error(`Native builtin '${view.slot ?? view.type}' is unavailable.`);
    const props: Record<string, unknown> = {
      ...(view.type === "builtin" ? originalProps : {}),
      ...(bind(view.props ?? {}, originalProps) as Record<string, unknown>),
      ...(key === undefined ? {} : { key }),
    };
    if (view.command) {
      const command = view.command;
      props[command.event ?? "onPress"] = () => {
        void host
          .invoke(host.environmentId, command.method, bind(command.input, originalProps))
          .catch((cause: unknown) => {
            ReactNative.Alert.alert(
              m(msg("Plugin command failed")),
              cause instanceof Error ? cause.message : String(cause),
            );
          });
      };
    }
    const renderChild = (child: unknown, childKey?: number): import("react").ReactNode =>
      Array.isArray(child)
        ? child.map((entry, index) => renderChild(entry, index))
        : record(child) && "type" in child
          ? render(host, child as unknown as NativeView, originalProps, targetSlot, childKey)
          : (bind(child, originalProps) as import("react").ReactNode);
    const children = renderChild(view.children);
    return React.createElement(
      component as import("react").ComponentType<object>,
      props,
      ...(view.children === undefined ? [] : [children]),
    );
  }
  return {
    manifest,
    activate: (host) => {
      const requireBuiltins = (value: unknown, targetSlot: string): void => {
        if (Array.isArray(value)) {
          for (const child of value) requireBuiltins(child, targetSlot);
        } else if (record(value) && "type" in value) {
          const view = value as unknown as NativeView;
          const slot =
            view.type === "builtin"
              ? (view.slot ?? targetSlot)
              : view.type === "button"
                ? "native.components.ui.button"
                : undefined;
          if (slot !== undefined && !host.getBuiltin(slot))
            throw new Error(`Native builtin '${slot}' is unavailable.`);
          requireBuiltins(view.children, targetSlot);
        }
      };
      for (const contribution of document.contributions)
        requireBuiltins(contribution.view, contribution.slot);
      for (const contribution of document.contributions) {
        host.register(
          contribution.slot,
          (props: object) => render(host, contribution.view, props, contribution.slot),
          contribution,
        );
      }
    },
  };
}
