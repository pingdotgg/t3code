import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

// Chrome pinned to the bottom edge renders under the Android gesture bar and
// the iOS home indicator unless it pads itself with the safe-area inset. The
// house convention is `Math.max(insets.bottom, N)` (see AndroidHomeFab and
// HomeScreen), so a React Native file that anchors content to the bottom and
// never reads the inset is almost always missing it.
const REACT_NATIVE_MODULE = /^react-native(\/|-|$)/u;
// `useSafeAreaInsets` alone proves nothing: a screen that only reads
// `insets.top` still leaves its bottom edge unpadded. Only a marker that
// names the bottom counts — `SafeAreaView` (which pads every edge by
// default), or a `bottomInset` prop handed down by whoever owns the inset.
const SAFE_AREA_BOTTOM_IDENTIFIERS = new Set(["SafeAreaView", "bottomInset"]);
const INSET_HOLDER_NAMES = new Set(["insets", "safeAreaInsets"]);
const SCROLL_CONTENT_ATTRIBUTES = new Set(["contentContainerStyle", "contentInset"]);
const SCROLL_BOTTOM_PROPERTIES = new Set(["bottom", "paddingBottom"]);

const getLiteralValue = (node: unknown): Option.Option<string | number> => {
  if (typeof node !== "object" || node === null) return Option.none();
  if (!("type" in node) || node.type !== "Literal") return Option.none();
  if (!("value" in node)) return Option.none();
  return typeof node.value === "string" || typeof node.value === "number"
    ? Option.some(node.value)
    : Option.none();
};

const getObjectProperties = (node: unknown): ReadonlyArray<unknown> => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression) || expression.value.type !== "ObjectExpression") return [];
  const { properties } = expression.value;
  return Array.isArray(properties) ? properties : [];
};

const findProperty = (
  properties: ReadonlyArray<unknown>,
  name: string,
): Option.Option<{ readonly value: unknown }> => {
  for (const property of properties) {
    if (typeof property !== "object" || property === null) continue;
    if (!("key" in property) || !("value" in property)) continue;

    const key = getPropertyName(property.key);
    if (Option.isSome(key) && key.value === name) {
      return Option.some(property as { readonly value: unknown });
    }
  }

  return Option.none();
};

const isAbsolutelyPositioned = (properties: ReadonlyArray<unknown>): boolean =>
  findProperty(properties, "position").pipe(
    Option.flatMap((property) => getLiteralValue(property.value)),
    Option.exists((value) => value === "absolute"),
  );

const getJsxAttributeName = (node: unknown): Option.Option<string> => {
  if (typeof node !== "object" || node === null || !("name" in node)) return Option.none();
  const name = node.name;
  if (typeof name !== "object" || name === null || !("type" in name)) return Option.none();
  return name.type === "JSXIdentifier" && "name" in name && typeof name.name === "string"
    ? Option.some(name.name)
    : Option.none();
};

const getJsxAttributeExpression = (node: unknown): unknown => {
  if (typeof node !== "object" || node === null || !("value" in node)) return undefined;
  const value = node.value;
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  return value.type === "JSXExpressionContainer" && "expression" in value
    ? value.expression
    : undefined;
};

const MESSAGE =
  "Bottom-anchored chrome must reserve the safe-area inset: this file pins content to the bottom edge with a fixed offset but never reads insets.bottom, so it renders under the Android gesture bar and the iOS home indicator. Read useSafeAreaInsets() and pad with Math.max(insets.bottom, N), or take the inset from the parent as a bottomInset prop.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require React Native surfaces that anchor content to the bottom edge to account for the safe-area inset.",
    },
  },
  createOnce(context) {
    let isReactNativeFile = false;
    let readsSafeAreaInset = false;
    const candidates: Array<unknown> = [];

    const reset = () => {
      isReactNativeFile = false;
      readsSafeAreaInset = false;
      candidates.length = 0;
    };

    return {
      before: reset,
      ImportDeclaration(node) {
        const source = getLiteralValue(node.source);
        if (
          Option.exists(
            source,
            (value) => typeof value === "string" && REACT_NATIVE_MODULE.test(value),
          )
        ) {
          isReactNativeFile = true;
        }
      },
      Identifier(node) {
        if (typeof node.name !== "string") return;
        if (SAFE_AREA_BOTTOM_IDENTIFIERS.has(node.name)) {
          readsSafeAreaInset = true;
        }
      },
      MemberExpression(node) {
        const property = getPropertyName(node.property);
        if (Option.isNone(property) || property.value !== "bottom") return;

        const object = unwrapExpression(node.object);
        if (Option.isNone(object) || object.value.type !== "Identifier") return;
        if (INSET_HOLDER_NAMES.has(object.value.name)) {
          readsSafeAreaInset = true;
        }
      },
      ObjectExpression(node) {
        const properties = getObjectProperties(node);
        if (!isAbsolutelyPositioned(properties)) return;

        const bottom = findProperty(properties, "bottom");
        if (Option.isNone(bottom)) return;

        // `bottom: 0` is how a keyboard-synced overlay attaches to the very
        // edge while its child owns the padding; only a fixed non-zero gap
        // claims to have measured the bottom edge itself.
        const value = getLiteralValue(bottom.value.value);
        if (Option.exists(value, (literal) => typeof literal === "number" && literal !== 0)) {
          candidates.push(bottom.value);
        }
      },
      JSXAttribute(node) {
        const name = getJsxAttributeName(node);
        if (Option.isNone(name) || !SCROLL_CONTENT_ATTRIBUTES.has(name.value)) return;

        const properties = getObjectProperties(getJsxAttributeExpression(node));
        for (const propertyName of SCROLL_BOTTOM_PROPERTIES) {
          const property = findProperty(properties, propertyName);
          if (Option.isNone(property)) continue;
          if (Option.isSome(getLiteralValue(property.value.value))) {
            candidates.push(property.value);
          }
        }
      },
      "Program:exit"() {
        if (!isReactNativeFile || readsSafeAreaInset) return;

        for (const candidate of candidates) {
          context.report({ node: candidate as never, message: MESSAGE });
        }
      },
    };
  },
});
