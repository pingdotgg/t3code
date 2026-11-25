import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const MESSAGE =
  "Untranslated copy. Wrap JSX text in <T>, props in gt(), and strings outside React in m(msg()). See docs/internals/14_i18n.md.";

// Props and object keys whose string values users read.
const COPY_NAMES = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "caption",
  "children",
  "description",
  "detail",
  "emptyState",
  "error",
  "heading",
  "headline",
  "hint",
  "label",
  "message",
  "notice",
  "placeholder",
  "subtitle",
  "summary",
  "text",
  "title",
  "tooltip",
]);
const COPY_NAME_SUFFIX =
  /(?:Label|Title|Tooltip|Description|Placeholder|Hint|Heading|Message|Reason|Text)$/u;
const COPY_ATTRIBUTES = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "placeholder",
  "title",
]);

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

// Atom command and query options: their `label` names the operation in logs.
const LOG_LABEL_CALLS = new Set([
  "executeAtomQuery",
  "reportAtomCommandResult",
  "runAtomCommand",
  "useAtomCommand",
  "useAtomQueryRunner",
  "useOrchestrationCommand",
]);
const LOG_LABEL_SIBLINGS = new Set(["reportDefect", "reportFailure", "refresh"]);
// Error payloads are data for logs and callers; the screen translates at the call site.
const ERROR_CLASS_NAME = /(?:Error|Refusal|Failure|Exception|Defect)$/u;

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

// Key names that are also common words: exempt only as the whole text.
const WHOLE_TEXT_NAMES = new Set([
  "Delete",
  "Down",
  "End",
  "Enter",
  "Home",
  "Left",
  "Option",
  "Right",
  "Space",
  "Tab",
  "Up",
  // navigator.platform values.
  "Win32",
  "MacIntel",
]);

// Names shown as-is in every language. Removed from the text before looking for words.
const PROPER_NOUNS = [
  "T3 Code",
  "T3 Connect",
  "T3 Chat",
  "GitHub",
  "GitLab",
  "Bitbucket",
  "Azure DevOps",
  "Forgejo",
  "Codex",
  "Claude",
  "Claude Code",
  "Cursor",
  "Devin",
  "Grok",
  "Grok Build",
  "OpenCode",
  "Antigravity",
  "Kiro",
  "Pi",
  "Muse Code",
  "OpenAI",
  "OpenRouter",
  "Anthropic",
  "Tailscale",
  "Simlock",
  "macOS",
  "Windows",
  "Linux",
  "iOS",
  "Android",
  "ChromeOS",
  "Finder",
  "CarPlay",
  "VoiceOver",
  "Liquid Glass",
  "One UI",
  "Material",
  "Material You",
  "KDE Plasma",
  "GNOME",
  "Niri",
  "Hyprland",
  "SF Pro",
  "SF Mono",
  "Chrome",
  "Edge",
  "Firefox",
  "Opera",
  "Safari",
  "Samsung Internet",
  // Programming languages and formats.
  "Bash",
  "Dart",
  "Dockerfile",
  "Elixir",
  "Go",
  "GraphQL",
  "Haskell",
  "Java",
  "JavaScript",
  "Kotlin",
  "Lua",
  "Markdown",
  "Mermaid",
  "PowerShell",
  "Python",
  "Ruby",
  "Rust",
  "Scala",
  "Svelte",
  "Swift",
  "TypeScript",
  "Vue",
  "Zig",
  // Modifier keys, never words.
  "Alt",
  "Backspace",
  "Cmd",
  "Ctrl",
  "Esc",
  "Shift",
  "PageUp",
  "PageDown",
];
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const PROPER_NOUN_PATTERN = new RegExp(
  `(?<![\\p{L}\\d])(?:${PROPER_NOUNS.toSorted((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|")})(?![\\p{L}\\d])`,
  "gu",
);

const HAS_WORD = /\p{L}\p{L}/u;
const URL_OR_PATH = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|data:|\/|\.\.?\/|~\/|#)/u;
// One lowercase token is an id, key, command, or icon name, not a sentence.
const CODE_TOKEN = /^[a-z0-9@$_.:/=-][^\s]*$/u;
// One all-caps token is an acronym or format name: HEX, PDF, SSH, JSON.
const ACRONYM = /^[\p{Lu}\d][\p{Lu}\d+#.]*$/u;
// One token with a capital after a lowercase letter is an identifier or brand: PageUp, OpenAI.
const CAMEL_TOKEN = /^[\p{L}\d.]*\p{Ll}\p{Lu}[\p{L}\d.]*$/u;
const TEMPLATE_PLACEHOLDER = /\{\{[^}]*\}\}/gu;
const CLASS_CHARACTER = /[-:/[\]]/u;

// A Tailwind class list: lowercase tokens with utility punctuation, as in cva variant maps.
const isClassList = (text: string) =>
  !/\p{Lu}/u.test(text) && text.split(" ").every((token) => CLASS_CHARACTER.test(token));

const normalize = (raw: string) => raw.replace(/\s+/gu, " ").trim();

const isCopy = (raw: string) => {
  const text = normalize(raw);
  if (!HAS_WORD.test(text) || URL_OR_PATH.test(text) || CODE_TOKEN.test(text)) return false;
  if (text === "OK") return true;
  if (WHOLE_TEXT_NAMES.has(text) || ACRONYM.test(text) || CAMEL_TOKEN.test(text)) return false;
  if (isClassList(text)) return false;
  return HAS_WORD.test(text.replace(TEMPLATE_PLACEHOLDER, " ").replace(PROPER_NOUN_PATTERN, " "));
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

const isLiteralUnion = (type: ESTree.TSType): boolean =>
  type.type === "TSLiteralType" ||
  (type.type === "TSUnionType" &&
    type.types.every(
      (member) =>
        member.type === "TSLiteralType" ||
        member.type === "TSNullKeyword" ||
        member.type === "TSUndefinedKeyword",
    ));

const enclosingFunction = (node: ESTree.Node) => {
  for (let current = node.parent; current; current = current.parent) {
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return current;
    }
  }
  return undefined;
};

const isCopyName = (name: string) => COPY_NAMES.has(name) || COPY_NAME_SUFFIX.test(name);

const calleeName = (callee: unknown) => {
  const node = unwrapExpression(callee);
  if (Option.isNone(node)) return undefined;
  if (node.value.type === "Identifier") return node.value.name;
  if (node.value.type === "MemberExpression") {
    return Option.getOrUndefined(getPropertyName(node.value.property));
  }
  return undefined;
};

const elementName = (node: ESTree.JSXElement): string | undefined => {
  const name = node.openingElement.name;
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") return name.property.name;
  return undefined;
};

const nonCopyAncestors = (node: ESTree.Node) => {
  const names = new Set<string>();
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "JSXElement") {
      const name = elementName(current);
      if (name !== undefined && NON_COPY_ELEMENTS.has(name)) names.add(name);
    }
  }
  return names;
};

const insideNonCopyElement = (node: ESTree.Node) => nonCopyAncestors(node).size > 0;

// Inside only <code>, a plain sentence is copy: capitalized words, no code punctuation.
const isPlainSentenceInCode = (ancestors: ReadonlySet<string>, raw: string) => {
  const text = normalize(raw);
  return (
    ancestors.size === 1 &&
    ancestors.has("code") &&
    /^\p{Lu}[\p{L}\d ,.'!?]*$/u.test(text) &&
    text.includes(" ") &&
    isCopy(text)
  );
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

const isNonCopyProperty = (object: ESTree.ObjectExpression, name: string) => {
  const owner = object.parent;
  if (owner?.type === "NewExpression" && object === owner.arguments[0]) {
    if (ERROR_CLASS_NAME.test(calleeName(owner.callee) ?? "")) return true;
  }
  if (name !== "label") return false;
  if (owner?.type === "CallExpression" && LOG_LABEL_CALLS.has(calleeName(owner.callee) ?? "")) {
    return true;
  }
  return object.properties.some((property) => {
    if (property.type !== "Property") return false;
    const key = getPropertyName(property.key);
    return Option.isSome(key) && LOG_LABEL_SIBLINGS.has(key.value);
  });
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
    const report = (node: ESTree.Node) => context.report({ node, message: MESSAGE });
    const reportLeaves = (expression: unknown) => {
      for (const leaf of literalLeaves(expression)) report(leaf);
    };
    // Type aliases in this file that are unions of literals: returning a member is not copy.
    const literalUnionAliases = new Set<string>();
    return {
      Program(node) {
        for (const statement of node.body) {
          const declaration =
            statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
          if (
            declaration?.type === "TSTypeAliasDeclaration" &&
            isLiteralUnion(declaration.typeAnnotation)
          ) {
            literalUnionAliases.add(declaration.id.name);
          }
        }
      },
      JSXText(node) {
        const ancestors = nonCopyAncestors(node);
        if (
          ancestors.size === 0 ? isCopy(node.value) : isPlainSentenceInCode(ancestors, node.value)
        ) {
          report(node);
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
        const value = node.value;
        if (value?.type === "Literal") reportLeaves(value);
        else if (value?.type === "JSXExpressionContainer") reportLeaves(value.expression);
      },
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === undefined) return;
        if (name === "setAttribute") {
          const attribute = unwrapExpression(node.arguments[0]);
          if (
            Option.isSome(attribute) &&
            attribute.value.type === "Literal" &&
            typeof attribute.value.value === "string" &&
            COPY_ATTRIBUTES.has(attribute.value.value)
          ) {
            reportLeaves(node.arguments[1]);
          }
          return;
        }
        const copyArguments =
          COPY_CALLS.get(name) ?? (COPY_CALL_NAME.test(name) ? node.arguments.length : 0);
        for (const argument of node.arguments.slice(0, copyArguments)) reportLeaves(argument);
      },
      // Label helpers: a function returning a sentence returns copy.
      ReturnStatement(node) {
        if (isErrorMessageGetter(node)) return;
        const returnType = enclosingFunction(node)?.returnType?.typeAnnotation;
        if (
          returnType !== undefined &&
          (isLiteralUnion(returnType) ||
            (returnType.type === "TSTypeReference" &&
              returnType.typeName.type === "Identifier" &&
              literalUnionAliases.has(returnType.typeName.name)))
        ) {
          return;
        }
        for (const leaf of literalLeaves(node.argument)) {
          if (hasCapitalizedWord(leafText(leaf))) report(leaf);
        }
      },
      Property(node) {
        if (node.parent?.type !== "ObjectExpression" || node.computed) return;
        const name = getPropertyName(node.key);
        if (Option.isNone(name) || !isCopyName(name.value)) return;
        if (isNonCopyProperty(node.parent, name.value)) return;
        reportLeaves(node.value);
      },
      // Defaults such as `emptyLabel = "No results"` are copy.
      AssignmentPattern(node) {
        if (node.left.type === "Identifier" && isCopyName(node.left.name)) reportLeaves(node.right);
      },
    };
  },
});
