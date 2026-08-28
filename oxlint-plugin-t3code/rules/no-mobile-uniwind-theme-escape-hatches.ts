import { defineRule, type Variable } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const MOBILE_SOURCE_MARKER = "/apps/mobile/src/";
const APPEARANCE_VARIANT_PATTERN = /\b(?:dark|light):(?=\S)/u;
const APPEARANCE_VARIANT_MESSAGE =
  "dark:/light: utilities do not follow registered custom themes; use an adaptive semantic token.";
const THEME_INTEROP_ALLOWLIST = new Set([
  "features/archive/ArchivedThreadsScreen.tsx",
  "features/connection/ConnectionsNewRouteScreen.tsx",
  "features/files/FileMarkdownPreview.tsx",
  "features/files/SourceFileSurface.tsx",
  "features/files/ThreadFilesRouteScreen.tsx",
  "features/files/thread-file-navigator-pane.tsx",
  "features/home/HomeHeader.tsx",
  "features/review/ReviewSheet.tsx",
  "features/review/useNativeReviewDiffBridge.ts",
  "features/settings/SettingsEnvironmentsRouteScreen.tsx",
  "features/settings/appearance/components/AppearancePreviews.tsx",
  "features/settings/appearance/components/FontSizeSliderRow.tsx",
  "features/threads/GitActionProgressOverlay.tsx",
  "features/threads/NewTaskContextPickerScreens.tsx",
  "features/threads/NewTaskDraftScreen.tsx",
  "features/threads/ThreadComposer.tsx",
  "features/threads/ThreadFeed.tsx",
  "features/threads/ThreadSettingsSheet.tsx",
  "features/threads/git/GitOverviewSheet.tsx",
  "features/threads/thread-list-items.tsx",
  "features/threads/thread-list-v2-items.tsx",
  "lib/useMobileNavigationTheme.ts",
  "native/T3ComposerEditor.ios.tsx",
  "native/T3ComposerEditor.native.tsx",
]);

const mobileSourcePath = (filename: string): string | undefined => {
  const normalized = `/${filename.replaceAll("\\", "/")}`;
  const markerIndex = normalized.lastIndexOf(MOBILE_SOURCE_MARKER);
  return markerIndex === -1
    ? undefined
    : normalized.slice(markerIndex + MOBILE_SOURCE_MARKER.length);
};

const literalStringValue = (node: unknown): Option.Option<string> => {
  if (typeof node !== "object" || node === null) return Option.none();
  if (!("type" in node) || node.type !== "Literal") return Option.none();
  if (!("value" in node) || typeof node.value !== "string") return Option.none();
  return Option.some(node.value);
};

const reportsAppearanceVariant = (value: string) => APPEARANCE_VARIANT_PATTERN.test(value);

const importsModule = (source: string, modulePath: string): boolean =>
  source.replace(/\.[cm]?[jt]sx?$/u, "").endsWith(modulePath);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep mobile theme styling on semantic Uniwind classes and reviewed native interop boundaries.",
    },
  },
  create(context) {
    const sourcePath = mobileSourcePath(context.filename);
    if (sourcePath === undefined) return {};

    const uniwindNamespaces = new Set<Variable>();

    const resolveVariable = (node: unknown): Variable | undefined => {
      const identifier = unwrapExpression(node);
      if (Option.isNone(identifier) || identifier.value.type !== "Identifier") return undefined;

      let scope = context.sourceCode.getScope(identifier.value);
      while (true) {
        const variable = scope.set.get(identifier.value.name);
        if (variable !== undefined || scope.upper === null) return variable;
        scope = scope.upper;
      }
    };

    return {
      ImportDeclaration(node) {
        const source = literalStringValue(node.source);
        if (Option.isNone(source)) return;
        const declaredVariables = context.sourceCode.getDeclaredVariables(node);

        for (const specifier of node.specifiers) {
          const local = unwrapExpression(specifier.local);
          const importedName =
            specifier.type === "ImportSpecifier"
              ? getPropertyName(specifier.imported)
              : Option.none();
          const isTypeOnly =
            node.importKind === "type" ||
            (specifier.type === "ImportSpecifier" && specifier.importKind === "type");

          if (
            !isTypeOnly &&
            specifier.type === "ImportNamespaceSpecifier" &&
            Option.isSome(local) &&
            local.value.type === "Identifier"
          ) {
            const localName = local.value.name;
            const variable = declaredVariables.find((candidate) => candidate.name === localName);
            if (source.value === "uniwind" && variable !== undefined) {
              uniwindNamespaces.add(variable);
            }
          }

          if (
            !isTypeOnly &&
            source.value === "uniwind" &&
            Option.isSome(importedName) &&
            importedName.value === "useCSSVariable"
          ) {
            context.report({
              node: specifier,
              message:
                "Use a semantic className instead of useCSSVariable; it adds a React theme subscription.",
            });
          }

          if (!isTypeOnly && importsModule(source.value, "/useThemeColor")) {
            context.report({
              node: specifier,
              message: "useThemeColor was replaced by semantic Uniwind classes.",
            });
          }

          if (
            !isTypeOnly &&
            importsModule(source.value, "/useUniwindTheme") &&
            !THEME_INTEROP_ALLOWLIST.has(sourcePath)
          ) {
            context.report({
              node: specifier,
              message:
                "Use className for theme styling, or review and add this native/third-party interop boundary to the lint allowlist.",
            });
          }
        }
      },
      MemberExpression(node) {
        const object = unwrapExpression(node.object);
        if (Option.isNone(object) || object.value.type !== "Identifier") return;

        const property = getPropertyName(node.property);
        if (Option.isNone(property)) return;

        const namespace = resolveVariable(object.value);
        if (
          namespace !== undefined &&
          uniwindNamespaces.has(namespace) &&
          property.value === "useCSSVariable"
        ) {
          context.report({
            node,
            message:
              "Use a semantic className instead of useCSSVariable; it adds a React theme subscription.",
          });
        }
      },
      VariableDeclarator(node) {
        const initializer = unwrapExpression(node.init);
        const binding = unwrapExpression(node.id);
        if (
          Option.isNone(initializer) ||
          initializer.value.type !== "Identifier" ||
          Option.isNone(binding)
        ) {
          return;
        }

        const namespace = resolveVariable(initializer.value);
        if (namespace === undefined || !uniwindNamespaces.has(namespace)) return;

        if (binding.value.type === "Identifier") {
          const bindingName = binding.value.name;
          const variable = context.sourceCode
            .getDeclaredVariables(node)
            .find((candidate) => candidate.name === bindingName);
          if (variable !== undefined) uniwindNamespaces.add(variable);
          return;
        }

        if (binding.value.type !== "ObjectPattern") return;

        const declaredVariables = context.sourceCode.getDeclaredVariables(node);
        for (const propertyNode of binding.value.properties) {
          if (propertyNode.type === "RestElement") {
            const restBinding = unwrapExpression(propertyNode.argument);
            if (Option.isNone(restBinding) || restBinding.value.type !== "Identifier") continue;

            const restName = restBinding.value.name;
            const variable = declaredVariables.find((candidate) => candidate.name === restName);
            if (variable !== undefined) uniwindNamespaces.add(variable);
            continue;
          }

          if (propertyNode.type !== "Property") continue;
          const property = getPropertyName(propertyNode.key);
          if (Option.isNone(property)) continue;

          if (property.value === "useCSSVariable") {
            context.report({
              node: propertyNode,
              message:
                "Use a semantic className instead of useCSSVariable; it adds a React theme subscription.",
            });
          }
        }
      },
      Literal(node) {
        if (typeof node.value !== "string" || !reportsAppearanceVariant(node.value)) return;
        context.report({ node, message: APPEARANCE_VARIANT_MESSAGE });
      },
      TemplateElement(node) {
        if (!reportsAppearanceVariant(node.value.cooked ?? "")) return;
        context.report({ node, message: APPEARANCE_VARIANT_MESSAGE });
      },
    };
  },
});
