import { THEME_COLOR_ROLES } from "./themePalettes.ts";

const FETCHES_BY_STRING = /image-set\(|\bsrc\(/i;
// Only CSS whitespace may come first. \s also matches U+00A0, which makes the address relative.
const URL_NOT_LOCAL = /url\((?![ \t\n\f\r]*["']?(?:data:|#))/i;
// Read tokens left to right, as CSS does: a url( inside a string loads nothing, and a quote in an
// unquoted url( is not a string. A quoted url() that is not data: or #id keeps `url(` for the check.
const URL_OR_STRING =
  /url\((?![ \t\n\f\r]*["'])[^)]*|url\([ \t\n\f\r]*("[^"\n\r\f]*"|'[^'\n\r\f]*')|"[^"\n\r\f]*"|'[^'\n\r\f]*'/gi;

/** The code with its strings removed, keeping `url(` where a quoted url() can load a file. */
function withoutStrings(code: string): string {
  return code.replace(URL_OR_STRING, (token, urlString: string | undefined) => {
    if (urlString !== undefined) return /^["'](?:data:|#)/i.test(urlString) ? "" : "url(";
    return token.startsWith('"') || token.startsWith("'") ? "" : token;
  });
}

function fetchesOutsideStrings(code: string): boolean {
  return FETCHES_BY_STRING.test(code) || URL_NOT_LOCAL.test(code);
}

/**
 * Whether one declaration value can load a remote file. Clients drop those declarations.
 * A value with var() stays unparsed until use, and an escape can spell `var` or `url` in it,
 * so every value that still has a backslash is refused.
 */
export function themeCssValueFetches(value: string): boolean {
  return value.includes("\\") || fetchesOutsideStrings(withoutStrings(value));
}

/** A text check for early feedback. CSS escapes can dodge it; the client check is the guard. */
export function themeCssLoadsRemoteFiles(css: string): boolean {
  const code = withoutStrings(css.replace(/\/\*[\s\S]*?\*\//g, ""));
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
  { selector: "[data-theme-scene]", styles: "root, while a theme scene runs behind the app" },
  { selector: '[data-slot="sidebar-inset"]', styles: "main area beside the sidebar" },
  { selector: "[data-chat-view]", styles: "chat view, around the conversation and its panels" },
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
  'For an animated scene, copy an HTML page of up to 4 MB to `<themesDir>/<themeId>.html`. It runs with scripts in a sandboxed frame behind the app, with no access to the app, and may load scripts from the web. It receives `{ type: "t3-theme-scene:pointer", x, y }` and `{ type: "t3-theme-scene:pointer-leave" }` messages. While it runs, the root has `data-theme-scene`; give the surfaces it should show through a transparent background, such as `[data-theme-scene] [data-slot="sidebar-inset"], [data-theme-scene] [data-chat-view], [data-theme-scene] [data-workspace-area="conversation"] { background: transparent; }`.',
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
