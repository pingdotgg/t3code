import { THEME_COLOR_ROLES } from "./themePalettes.ts";

const FETCHES_BY_STRING = /image-set\(|\bsrc\(/i;
// Only CSS whitespace may come first. \s also matches U+00A0, which makes the address relative.
const URL_NOT_LOCAL = /url\((?![ \t\n\f\r]*["']?(?:data:|#))/i;
// Read tokens left to right, as CSS does: a url( or /* inside a string loads nothing, and a quote
// in an unquoted url( or after a backslash is not a string. A quoted url() that is not data: or #id
// keeps `url(` for the check.
const ESCAPE = String.raw`\\(?:(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{1,5}(?![0-9a-fA-F]))(?:\r\n|[\n\r\f])?|\r\n|[^0-9a-fA-F])`;
const STRING = String.raw`"(?:${ESCAPE}|[^"\\\n\r\f])*"|'(?:${ESCAPE}|[^'\\\n\r\f])*'`;
const URL_OR_STRING = String.raw`url\((?![ \t\n\f\r]*["'])([^)]*)|url\([ \t\n\f\r]*(${STRING})|${STRING}|${ESCAPE}`;
const CSS_TOKENS = new RegExp(String.raw`\/\*[\s\S]*?\*\/|${URL_OR_STRING}`, "gi");

/**
 * The code with its strings and comments removed, keeping `url(` where a quoted url() can load a
 * file. A declaration value keeps a comment that holds an escape. In a stylesheet an unquoted url()
 * is judged by its address too.
 */
function withoutStrings(code: string, stylesheet: boolean): string {
  return code.replace(CSS_TOKENS, (token, address?: string, urlString?: string) => {
    const url = stylesheet ? (address ?? urlString) : urlString;
    if (url !== undefined) {
      return /^[ \t\n\f\r]*["']?(?:data:|#)/i.test(url) ? "" : "url(";
    }
    if (token.startsWith("/*")) {
      if (stylesheet) return "";
      return token.includes("\\") ? token : " ";
    }
    return /^["']/.test(token) ? "" : token;
  });
}

function fetchesOutsideStrings(code: string): boolean {
  return FETCHES_BY_STRING.test(code) || URL_NOT_LOCAL.test(code);
}

/**
 * Whether one declaration value can load a remote file. Clients drop those declarations.
 * Values with var() can keep escapes that spell `var` or `url`. Refuse escapes that survive
 * removing plain strings and local quoted url() values.
 */
export function themeCssValueFetches(value: string): boolean {
  const code = withoutStrings(value, false);
  return code.includes("\\") || fetchesOutsideStrings(code);
}

const WHITESPACE = String.raw`[ \t\n\f\r]`;
const NAME_ESCAPE = String.raw`\\(?:[0-9a-fA-F]{1,6}(?:\r\n|${WHITESPACE})?|[^\n\r\f0-9a-fA-F])`;
const NAME = String.raw`(?:${NAME_ESCAPE}|[-\w\u0080-\uffff])+`;
const BLOCK_TOKENS = new RegExp(
  String.raw`\/\*[\s\S]*?(?:\*\/|$)|${STRING}|(${NAME})(\()?|[()[\]{};]`,
  "g",
);
// An unquoted url() is one token: quotes, comments and brackets inside it are part of the address.
const UNQUOTED_URL = new RegExp(String.raw`(?!${WHITESPACE}*["'])(?:${NAME_ESCAPE}|[^)])*\)?`, "y");
const NAME_ESCAPES = new RegExp(
  String.raw`\\(?:([0-9a-fA-F]{1,6})(?:\r\n|${WHITESPACE})?|([^]))`,
  "g",
);
const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

const isUrlFunction = (name: string) =>
  name
    .replace(NAME_ESCAPES, (_, hex?: string, char?: string) =>
      hex ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)) : (char ?? ""),
    )
    .toLowerCase() === "url";

/**
 * The CSS without the declarations that `drop` refuses, asked only for text that could load a
 * remote file. A browser hides a var() shorthand's text once a later declaration overrides one of
 * its longhands, so only the source has it. Brackets are tracked as the CSS parser does; an unsure
 * split is left out, so one candidate can hold several declarations or rules.
 */
export function themeCssWithoutDeclarations(
  css: string,
  drop: (candidate: string) => boolean,
): string {
  let kept = "";
  const open: string[] = [];
  let start = 0;
  const cut = (end: number) => {
    const text = css.slice(start, end);
    const candidate = text.includes("\\") || fetchesOutsideStrings(text);
    kept += (candidate && drop(text) ? "" : text) + css.slice(end, end + 1);
    start = end + 1;
  };
  BLOCK_TOKENS.lastIndex = 0;
  for (let match = BLOCK_TOKENS.exec(css); match; match = BLOCK_TOKENS.exec(css)) {
    const [token, name, paren] = match;
    if (name !== undefined) {
      if (!paren) continue;
      UNQUOTED_URL.lastIndex = BLOCK_TOKENS.lastIndex;
      const url = isUrlFunction(name) && UNQUOTED_URL.test(css);
      if (url) BLOCK_TOKENS.lastIndex = UNQUOTED_URL.lastIndex;
      else open.push(")");
    } else if (token in CLOSERS && (token !== "{" || open.length > 0)) {
      open.push(CLOSERS[token] ?? "");
    } else if (token === open.at(-1)) {
      open.pop();
    } else if (open.length === 0 && (token === ";" || token === "{" || token === "}")) {
      cut(match.index);
    }
  }
  cut(css.length);
  return kept;
}

/** A text check for early feedback. CSS escapes can dodge it; the client check is the guard. */
export function themeCssLoadsRemoteFiles(css: string): boolean {
  const code = withoutStrings(css, true);
  return /@import/i.test(code) || fetchesOutsideStrings(code);
}

/**
 * Selectors that theme CSS may rely on. Other class names are Tailwind utilities and change
 * between releases. themeCss.test.ts in apps/web fails when one of these leaves the source.
 */
export const THEME_CSS_HOOKS = [
  { selector: '[data-slot="sidebar"]', styles: "app sidebar" },
  { selector: '[data-slot="sidebar-inner"]', styles: "sidebar surface" },
  { selector: "[data-thread-item]", styles: "sidebar thread row" },
  {
    selector: '[data-slot="project-monogram"]',
    styles: "project icon with letters; its svg holds the tile",
  },
  { selector: "[data-chat-header]", styles: "chat header" },
  { selector: '[data-workspace-area="conversation"]', styles: "chat area, behind the messages" },
  { selector: ".messages-timeline-scroll", styles: "chat scroller" },
  { selector: "[data-timeline-row-kind]", styles: 'chat row, such as ="message" or ="work"' },
  { selector: '[data-message-role="user"]', styles: "user message row" },
  { selector: "[data-user-message-bubble]", styles: "user message bubble" },
  { selector: '[data-message-role="assistant"]', styles: "assistant message row" },
  { selector: ".chat-markdown", styles: "assistant text" },
  { selector: ".chat-markdown-codeblock", styles: "code block" },
  { selector: "[data-chat-composer-form]", styles: "composer" },
  { selector: '[data-slot="composer-host"]', styles: "composer card" },
  { selector: ".composer-tiptap", styles: "composer text" },
  { selector: "[data-thread-details-card]", styles: "thread details card" },
  { selector: "[data-thread-terminal-drawer]", styles: "terminal drawer" },
  { selector: "[data-settings-page-scroll]", styles: "settings page" },
  { selector: '[data-slot="button"]', styles: "button" },
  { selector: '[data-slot="input"]', styles: "text input" },
  { selector: '[data-slot="switch"]', styles: "switch" },
  { selector: '[data-slot="select-trigger"]', styles: "select" },
  { selector: '[data-slot="dialog-popup"]', styles: "dialog" },
  { selector: '[data-slot="popover-popup"]', styles: "popover" },
  { selector: '[data-slot="menu-popup"]', styles: "menu" },
  { selector: '[data-slot="tooltip-popup"]', styles: "tooltip" },
  { selector: '[data-slot="scroll-area-scrollbar"]', styles: "overlay scrollbar" },
  { selector: '[data-slot="scroll-area-thumb"]', styles: "overlay scrollbar thumb" },
] as const;

/** What an agent needs to restyle the app. `t3_theme_read` returns it. */
export const THEME_GUIDE = [
  "Themes restyle T3 Code on web and desktop. Mobile does not use them.",
  "",
  "Colors: `canvas` and `accent` (hex) derive a full palette. `colors` overrides single roles, and `variants.light` or `variants.dark` does that for the other appearance. Prefer colors over CSS.",
  `Roles: ${THEME_COLOR_ROLES.join(", ")}.`,
  "",
  "CSS: `css` applies after the app's styles. Use `.dark` or `:root:not(.dark)` for one appearance.",
  "It cannot load files: no @import, no image-set(), and url() only with data: or #id.",
  'For a background image, copy a JPEG, PNG, or WebP file of up to 16 MB to `<themesDir>/<themeId>.jpg` (or .png, .webp), beside the theme file. CSS shows it with `var(--theme-background-image)`, such as `[data-workspace-area="conversation"] { background: var(--theme-background-image) center / cover no-repeat; }`. Delete the file to remove it. Do not embed images in `css`: it holds 100,000 characters.',
  "The app's own rules can be more specific. If a rule has no effect, add !important.",
  "It cannot reach the terminal text, the file tree, or diff internals. Use color roles for those.",
  "Native scrollbars take `::-webkit-scrollbar` and `::-webkit-scrollbar-thumb`.",
  "Icons are `svg.lucide`. stroke-width, stroke-linecap, and stroke-linejoin restyle them.",
  "",
  "Stable selectors (other class names change between releases, so do not use them):",
  ...THEME_CSS_HOOKS.map((hook) => `- ${hook.selector}: ${hook.styles}`),
  "",
  "You cannot see the result. Make small changes, then ask the user how it looks.",
  "To undo, set `t3-code`, the stock T3 Code theme, or another built-in theme. An empty `current` means the stock theme or no environment theme.",
].join("\n");
