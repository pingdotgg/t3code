import { THEME_COLOR_ROLES } from "./themePalettes.ts";

const FETCHES_BY_STRING = /image-set\(|\bsrc\(/i;
// Only CSS whitespace may come first. \s also matches U+00A0, which makes the address relative.
const URL_NOT_LOCAL = /url\((?![ \t\n\f\r]*["']?(?:data:|#))/i;

/**
 * Whether one declaration value can load a remote file. Clients drop those declarations.
 * A value with var() stays unparsed until use, and an escape can spell `var` or `url` in it,
 * so every value that still has a backslash is refused.
 */
export function themeCssValueFetches(value: string): boolean {
  return value.includes("\\") || FETCHES_BY_STRING.test(value) || URL_NOT_LOCAL.test(value);
}

/** A text check for early feedback. CSS escapes can dodge it; the client check is the guard. */
export function themeCssLoadsRemoteFiles(css: string): boolean {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return /@import/i.test(code) || FETCHES_BY_STRING.test(code) || URL_NOT_LOCAL.test(code);
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
  "A background image must be embedded as a data: address. `css` holds 20,000 characters, so keep the image near 10 KB.",
  "The app's own rules can be more specific. If a rule has no effect, add !important.",
  "It cannot reach the terminal text, the file tree, or diff internals. Use color roles for those.",
  "Native scrollbars take `::-webkit-scrollbar` and `::-webkit-scrollbar-thumb`.",
  "Icons are `svg.lucide`. stroke-width, stroke-linecap, and stroke-linejoin restyle them.",
  "",
  "Stable selectors (other class names change between releases, so do not use them):",
  ...THEME_CSS_HOOKS.map((hook) => `- ${hook.selector}: ${hook.styles}`),
  "",
  "You cannot see the result. Make small changes, then ask the user how it looks.",
  "To undo, set a built-in theme: t3-chat, grove, ocean, ember, or iris.",
].join("\n");
