import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const MESSAGE =
  "Untranslated copy. Wrap JSX text in <T>, props in gt(), and strings outside React in m(msg()). See docs/internals/i18n.md.";

// Props and object keys whose string values users read.
const COPY_NAMES = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "caption",
  "description",
  "detail",
  "error",
  "heading",
  "headline",
  "hint",
  "label",
  "message",
  "placeholder",
  "subtitle",
  "summary",
  "title",
  "tooltip",
]);
const COPY_NAME_SUFFIX =
  /(?:Label|Title|Tooltip|Description|Placeholder|Hint|Heading|Message|Reason|Text)$/u;

// Calls whose leading arguments are read or heard by the user: screen reader announcements,
// native dialogs.
const COPY_CALLS = new Map([
  ["announce", 1],
  ["confirm", 1],
  ["alert", 2],
  ["prompt", 2],
]);
// Setters and reporters whose every string argument ends up on screen.
const COPY_CALL_NAME =
  /^(?:set\w*(?:Error|Message|Notice|Status|Label|Title|Hint)|(?:report|show)\w*(?:Failure|Error|Notice)|on(?:Error|Failure))$/u;

// Text inside these renders code, a keybinding, or is already translated.
const NON_COPY_ELEMENTS = new Set([
  "T",
  "Var",
  "Num",
  "Currency",
  "DateTime",
  "RelativeTime",
  "code",
  "kbd",
  "pre",
  "samp",
  "script",
  "style",
  "Kbd",
  "KbdGroup",
]);

// Names and key labels shown as-is in every language.
const PROPER_NOUNS = new Set([
  "T3 Code",
  "GitHub",
  "GitLab",
  "Bitbucket",
  "Azure DevOps",
  "Forgejo",
  "Codex",
  "Claude",
  "Claude Code",
  "Cursor",
  "Grok",
  "OpenCode",
  "Antigravity",
  "Kiro",
  "Pi",
  "Muse Code",
  "Tailscale",
  "macOS",
  "Windows",
  "Linux",
  "iOS",
  "Android",
  "Finder",
  "Alt",
  "Backspace",
  "Cmd",
  "Ctrl",
  "Delete",
  "Down",
  "End",
  "Enter",
  "Esc",
  "Home",
  "Left",
  "Option",
  "Right",
  "Shift",
  "Space",
  "Tab",
  "Up",
]);

const HAS_WORD = /\p{L}\p{L}/u;
const URL_OR_PATH = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|\/|\.\.?\/|~\/|#)/u;
// One lowercase token is an id, key, command, or icon name, not a sentence.
const CODE_TOKEN = /^[a-z0-9@$_.:/=-][^\s]*$/u;

const isCopy = (raw: string) => {
  const text = raw.replace(/\s+/gu, " ").trim();
  return (
    HAS_WORD.test(text) &&
    !URL_OR_PATH.test(text) &&
    !CODE_TOKEN.test(text) &&
    !PROPER_NOUNS.has(text)
  );
};

const leafText = (leaf: ESTree.Node) =>
  leaf.type === "Literal"
    ? String(leaf.value)
    : leaf.type === "TemplateLiteral"
      ? leaf.quasis.map((quasi) => quasi.value.cooked ?? "").join(" ")
      : "";

// Returned strings are often CSS, commands, or class lists; sentences start with a capital.
const hasCapitalizedWord = (text: string) => /(?:^|\s)\p{Lu}\p{Ll}/u.test(text.trim());

// An Error's `get message()` text is for logs, not the screen.
const isErrorMessageGetter = (node: ESTree.Node) => {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "MethodDefinition") {
      return (
        current.kind === "get" && Option.getOrUndefined(getPropertyName(current.key)) === "message"
      );
    }
  }
  return false;
};

const isCopyName = (name: string) => COPY_NAMES.has(name) || COPY_NAME_SUFFIX.test(name);

const elementName = (node: ESTree.JSXElement): string | undefined => {
  const name = node.openingElement.name;
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") return name.property.name;
  return undefined;
};

const insideNonCopyElement = (node: ESTree.Node): boolean => {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "JSXElement") {
      const name = elementName(current);
      if (name !== undefined && NON_COPY_ELEMENTS.has(name)) return true;
    }
  }
  return false;
};

/** String and template literals an expression can evaluate to, through ternaries and fallbacks. */
const literalLeaves = (expression: unknown): ReadonlyArray<ESTree.Node> => {
  const node = unwrapExpression(expression);
  if (Option.isNone(node)) return [];
  const value = node.value;
  switch (value.type) {
    case "Literal":
      return typeof value.value === "string" && isCopy(value.value) ? [value] : [];
    case "TemplateLiteral":
      return isCopy(value.quasis.map((quasi) => quasi.value.cooked ?? "").join(" ")) ? [value] : [];
    case "ConditionalExpression":
      return [...literalLeaves(value.consequent), ...literalLeaves(value.alternate)];
    case "LogicalExpression":
      return value.operator === "&&"
        ? literalLeaves(value.right)
        : [...literalLeaves(value.left), ...literalLeaves(value.right)];
    default:
      return [];
  }
};

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag user-facing English that is not wrapped for translation: JSX text, copy props, and copy keys.",
    },
  },
  create(context) {
    const reportLeaves = (expression: unknown) => {
      for (const leaf of literalLeaves(expression))
        context.report({ node: leaf, message: MESSAGE });
    };
    return {
      JSXText(node) {
        if (isCopy(node.value) && !insideNonCopyElement(node)) {
          context.report({ node, message: MESSAGE });
        }
      },
      JSXExpressionContainer(node) {
        const parent = node.parent;
        if (parent?.type !== "JSXElement" && parent?.type !== "JSXFragment") return;
        if (insideNonCopyElement(node)) return;
        reportLeaves(node.expression);
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || !isCopyName(node.name.name)) return;
        if (insideNonCopyElement(node)) return;
        const value = node.value;
        if (value?.type === "Literal") reportLeaves(value);
        else if (value?.type === "JSXExpressionContainer") reportLeaves(value.expression);
      },
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee)) return;
        const name =
          callee.value.type === "Identifier"
            ? callee.value.name
            : callee.value.type === "MemberExpression"
              ? Option.getOrUndefined(getPropertyName(callee.value.property))
              : undefined;
        const copyArguments =
          name === undefined
            ? 0
            : (COPY_CALLS.get(name) ?? (COPY_CALL_NAME.test(name) ? node.arguments.length : 0));
        for (const argument of node.arguments.slice(0, copyArguments)) reportLeaves(argument);
      },
      // Label helpers: a function returning a sentence returns copy.
      ReturnStatement(node) {
        if (isErrorMessageGetter(node)) return;
        for (const leaf of literalLeaves(node.argument)) {
          if (hasCapitalizedWord(leafText(leaf))) context.report({ node: leaf, message: MESSAGE });
        }
      },
      Property(node) {
        if (node.parent?.type !== "ObjectExpression" || node.computed) return;
        const name = getPropertyName(node.key);
        if (Option.isSome(name) && isCopyName(name.value)) reportLeaves(node.value);
      },
    };
  },
});
