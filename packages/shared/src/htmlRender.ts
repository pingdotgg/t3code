import {
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  type ThemeAppearance,
  type ThemeColors,
} from "./themePalettes.ts";

/**
 * Agent-authored HTML pages ("HTML renders") are self-contained documents an
 * agent publishes into a thread with T3's `html_render` MCP tool. The server
 * stores each one as a thread attachment with a small bootstrap injected into
 * its head; clients show it in a sandboxed iframe (web, desktop) or WebView
 * (mobile) and hand it the active theme as CSS custom properties.
 */

export const HTML_RENDER_TOOL_NAME = "html_render";
export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
export const HTML_RENDER_MAX_TITLE_LENGTH = 200;

/** What the `html_render` tool result carries so clients can show the page. */
export interface HtmlRenderReference {
  readonly attachmentId: string;
  readonly title: string;
  /** The agent's frame height in CSS pixels, and the cap on any measured height. */
  readonly height: number;
  /**
   * `[width, contentHeight]` pairs the server measured at publish, ascending by
   * width. Absent when the preview browser was not installed yet.
   */
  readonly heights?: ReadonlyArray<readonly [width: number, height: number]>;
}

/** Frame widths the server measures a page at, from phones to the wide chat setting. */
export const HTML_RENDER_MEASURE_WIDTHS = [320, 375, 430, 520, 640, 728, 860, 1000, 1144] as const;

/**
 * The reply column's frame width at the default chat width. Agents preview at
 * it, and it picks the measured height when a client cannot know its width.
 */
export const HTML_RENDER_COLUMN_WIDTH = 728;

const MAX_MEASURED_HEIGHTS = 24;

function readMeasuredHeights(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEASURED_HEIGHTS) {
    return undefined;
  }
  const heights = value.flatMap((entry) =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    Number.isInteger(entry[0]) &&
    entry[0] >= 1 &&
    entry[0] <= 10_000 &&
    typeof entry[1] === "number" &&
    Number.isFinite(entry[1])
      ? [[entry[0] as number, clampHtmlRenderHeight(entry[1])] as const]
      : [],
  );
  return heights.length === value.length
    ? [...heights].sort((left, right) => left[0] - right[0])
    : undefined;
}

export function readHtmlRenderReference(value: unknown): HtmlRenderReference | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { attachmentId, title, height, heights } = value as Record<string, unknown>;
  if (
    typeof attachmentId !== "string" ||
    attachmentId.length === 0 ||
    attachmentId.length > 256 ||
    typeof title !== "string" ||
    typeof height !== "number" ||
    !Number.isFinite(height)
  ) {
    return undefined;
  }
  const measured = readMeasuredHeights(heights);
  return {
    attachmentId,
    title: title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML",
    height: clampHtmlRenderHeight(height),
    ...(measured === undefined ? {} : { heights: measured }),
  };
}

/** Whether two references show the same page at the same sizes. */
export function htmlRenderReferencesEqual(left: HtmlRenderReference, right: HtmlRenderReference) {
  return (
    left.attachmentId === right.attachmentId &&
    left.title === right.title &&
    left.height === right.height &&
    (left.heights ?? []).length === (right.heights ?? []).length &&
    (left.heights ?? []).every(
      ([width, height], index) =>
        right.heights?.[index]?.[0] === width && right.heights[index][1] === height,
    )
  );
}

// The taller of the heights measured at the nearest widths on each side. A
// breakpoint between two measured widths can make the page as tall as either.
function measuredHeight(heights: NonNullable<HtmlRenderReference["heights"]>, width: number) {
  const above = heights.findIndex(([measuredWidth]) => measuredWidth >= width);
  const high = above === -1 ? heights.length - 1 : above;
  const low = heights[high]![0] === width ? high : Math.max(0, high - 1);
  return Math.max(heights[low]![1], heights[high]![1]);
}

/**
 * The frame height for a page at a frame width. It is the page's own reported
 * `contentHeight` when the client has one, else the server's measurement for
 * that width. A page even a few pixels taller than its frame scrolls inside it
 * and takes the reader's scroll, so the frame fits the page. The agent's height
 * caps it only when it is below the page's height at the column width (the
 * agent asked for a scrolling frame) or when the page was never measured.
 */
export function htmlRenderFrameHeight(
  reference: HtmlRenderReference,
  width: number,
  contentHeight?: number,
) {
  const heights = reference.heights;
  if (heights === undefined || heights.length === 0) {
    return clampHtmlRenderHeight(Math.min(reference.height, contentHeight ?? reference.height));
  }
  const cap =
    measuredHeight(heights, HTML_RENDER_COLUMN_WIDTH) > reference.height
      ? reference.height
      : HTML_RENDER_MAX_HEIGHT;
  return clampHtmlRenderHeight(Math.min(cap, contentHeight ?? measuredHeight(heights, width)));
}

/** A readable download name: the title without characters file systems reject. */
export function htmlRenderFileName(title: string) {
  const name = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return `${name || "Page"}.html`;
}

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

export interface HtmlRenderFonts {
  readonly sans: string;
  readonly mono: string;
}

export const HTML_RENDER_DEFAULT_FONTS: HtmlRenderFonts = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  // Concrete names only: some engines alias `ui-monospace` to the proportional UI font.
  mono: '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
};

/**
 * Fonts the server's headless browser lays pages out with. Arial-metric faces
 * stand in for the system UI fonts readers see, so measured heights and
 * preview screenshots wrap text close to how a client will.
 */
export const HTML_RENDER_MEASURE_FONTS: HtmlRenderFonts = {
  sans: '"Liberation Sans", Arimo, Arial, Helvetica, sans-serif',
  mono: '"Liberation Mono", Cousine, Menlo, Consolas, monospace',
};

/** The resolved theme a client hands an HTML render. */
export interface HtmlRenderTheme {
  readonly appearance: ThemeAppearance;
  readonly variables: Readonly<Record<string, string>>;
}

// Roles themes cannot change (index.css keeps info/success fixed), plus a
// categorical chart series after the theme's own accent.
const FIXED_COLORS = {
  light: {
    success: "#10b981",
    successForeground: "#047857",
    info: "#3b82f6",
    infoForeground: "#1d4ed8",
    chart: ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"],
  },
  dark: {
    success: "#10b981",
    successForeground: "#34d399",
    info: "#3b82f6",
    infoForeground: "#60a5fa",
    chart: ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"],
  },
} as const;

/**
 * Maps a theme palette to the variables HTML renders style against. Names
 * follow the app's own tokens, except `--accent`, which is the theme's brand
 * color here rather than the app's neutral hover surface.
 */
export function htmlRenderTheme(
  colors: ThemeColors,
  appearance: ThemeAppearance,
  fonts: HtmlRenderFonts = HTML_RENDER_DEFAULT_FONTS,
): HtmlRenderTheme {
  const fixed = FIXED_COLORS[appearance];
  return {
    appearance,
    variables: {
      "--background": colors.canvas,
      "--foreground": colors.text,
      "--muted": colors.muted,
      "--muted-foreground": colors.mutedForeground,
      "--card": colors.surface,
      "--card-foreground": colors.text,
      "--popover": colors.surfaceOverlay,
      "--popover-foreground": colors.text,
      "--secondary": colors.secondary,
      "--secondary-foreground": colors.secondaryForeground,
      "--border": colors.border,
      "--input": colors.input,
      "--ring": colors.focus,
      "--primary": colors.messageAction,
      "--primary-foreground": colors.messageActionForeground,
      "--accent": colors.accent,
      "--accent-foreground": colors.accentForeground,
      "--accent-surface": colors.accentSurface,
      "--accent-surface-foreground": colors.accentSurfaceForeground,
      "--destructive": colors.error,
      "--destructive-foreground": colors.errorForeground,
      "--destructive-surface": colors.errorSurface,
      "--warning": colors.warning,
      "--warning-foreground": colors.warningForeground,
      "--warning-surface": colors.warningSurface,
      "--success": fixed.success,
      "--success-foreground": fixed.successForeground,
      "--info": fixed.info,
      "--info-foreground": fixed.infoForeground,
      "--code-background": colors.codeBackground,
      "--code-foreground": colors.codeForeground,
      "--chart-1": colors.accent,
      ...Object.fromEntries(fixed.chart.map((color, index) => [`--chart-${index + 2}`, color])),
      "--radius": "0.625rem",
      "--font-sans": fonts.sans,
      "--font-mono": fonts.mono,
    },
  };
}

/** Agent-facing reference for the injected variables, used in tool descriptions. */
export const HTML_RENDER_THEME_GUIDE = [
  "T3 injects its active theme as CSS custom properties on :root, and they follow the user's theme and light/dark mode live:",
  "--background (page background, identical to the thread around the frame), --foreground, --muted, --muted-foreground,",
  "--card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring,",
  "--primary, --primary-foreground (solid buttons), --accent, --accent-foreground (brand accent), --accent-surface, --accent-surface-foreground,",
  "--destructive, --destructive-foreground, --destructive-surface, --warning, --warning-foreground, --warning-surface,",
  "--success, --success-foreground, --info, --info-foreground, --code-background, --code-foreground,",
  "--chart-1 … --chart-6 (categorical series for charts), --radius, --font-sans, --font-mono.",
  "The base stylesheet sets html background/color/font from these, body margin to 0, and hides the page's scrollbar; your own CSS overrides it.",
].join(" ");

/** Agent-facing reference for replying from a page, used in the html_render description. */
export const HTML_RENDER_MESSAGE_GUIDE = [
  "A page can answer for the reader: call t3.send(text) from a click handler, for example on option buttons or a form's submit, and T3 sends the text to this thread as the reader's own message.",
  "It returns a Promise that rejects when the message was not sent, such as a call outside a click or key press, or in html_preview.",
  "Write the text as the reader would, with what they picked or entered, since it reaches you as their next message.",
].join(" ");

/** Agent-facing layout rules for a page that sits inside a reply. */
export const HTML_RENDER_LAYOUT_GUIDE = [
  `The frame is borderless on the thread's background, as wide as the reply column (${HTML_RENDER_COLUMN_WIDTH}px on desktop by default, wider if the reader widens chat, about 360px on phones), and its left edge lines up with your reply text.`,
  "The page sits on the thread's own background, so by default leave html, body, and the outermost element with no background color. This overrides general style preferences such as a fixed black page background.",
  "Use a fluid width with no horizontal padding on the outermost element, and no outer card, border, or banner title: the page is part of your reply.",
  "If a box needs its own background (a mock of a specific screen, a panel that must stand apart), give it at least 16px of padding on every side and var(--radius) corners, so content never touches its edge.",
  "Give charts fixed pixel heights rather than heights that scale with width.",
  "Let content set the page's height. Avoid viewport-based heights such as 100vh or height:100% on html or body; the frame grows to fit the page, so they can make it grow again and again.",
].join(" ");

// The bridge between a render and its client speaks the MCP Apps protocol
// (JSON-RPC over postMessage), so the same host code can later drive upstream
// MCP apps: https://github.com/modelcontextprotocol/ext-apps
const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
const OPEN_LINK_METHOD = "ui/open-link";
const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
const MESSAGE_METHOD = "ui/message";

/** The content height in a framed render's `ui/notifications/size-changed` notification. */
export function readHtmlRenderContentHeight(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== SIZE_CHANGED_METHOD) return undefined;
  const height =
    typeof params === "object" && params !== null
      ? (params as { height?: unknown }).height
      : undefined;
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : undefined;
}

/** A render's `ui/open-link` request, if `data` is one with an http(s) URL. */
export function readHtmlRenderLinkRequest(
  data: unknown,
): { readonly id: string | number; readonly url: string } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, id, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== OPEN_LINK_METHOD) return undefined;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  const url =
    typeof params === "object" && params !== null ? (params as { url?: unknown }).url : undefined;
  return typeof url === "string" && /^https?:\/\//i.test(url) ? { id, url } : undefined;
}

/**
 * A render's `ui/message` request, if `data` is one with user text. The page's
 * `t3.send(text)` sends one block; the MCP Apps SDK sends an array.
 */
export function readHtmlRenderMessageRequest(
  data: unknown,
): { readonly id: string | number; readonly text: string } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, id, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== MESSAGE_METHOD) return undefined;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  if (typeof params !== "object" || params === null) return undefined;
  const { role, content } = params as { role?: unknown; content?: unknown };
  if (role !== "user") return undefined;
  const texts: Array<string> = [];
  for (const block of Array.isArray(content) ? content : [content]) {
    if (typeof block !== "object" || block === null) return undefined;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type !== "text" || typeof text !== "string") return undefined;
    texts.push(text);
  }
  const text = texts.join("\n").trim();
  return text === "" ? undefined : { id, text };
}

/** The empty result a client sends back for a render's request. */
export function htmlRenderResult(id: string | number) {
  return { jsonrpc: "2.0", id, result: {} } as const;
}

/** The error a client sends back for a render's request it refused or could not complete. */
export function htmlRenderError(id: string | number, message: string) {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } } as const;
}

const THEME_FRAGMENT_KEY = "t3-theme";

/** URL fragment that hands a render its theme before first paint. */
export function htmlRenderThemeFragment(theme: HtmlRenderTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

/** The `host-context-changed` notification a client posts into a mounted render when the theme changes. */
export function htmlRenderThemeMessage(theme: HtmlRenderTheme) {
  return {
    jsonrpc: "2.0",
    method: HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  } as const;
}

// The frame scrolls a page taller than itself, but a scrollbar inside the
// reply reads as a box within the thread, so it stays hidden.
const BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}";

function rootRule(theme: HtmlRenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{color-scheme:${theme.appearance};${declarations}}`;
}

// Runs synchronously in <head>, before the page's own styles and body, so the
// first paint is already themed. It rewrites its own <style> element rather
// than setting inline properties, so a page's later `:root` rules still win,
// then drops the fragment so a page's own hash routing never sees it. A link
// the reader clicks to another page never replaces the page inside the thread:
// a framed page asks its client to open it, and a top-level page (mobile)
// opens it as a new window, which the client sends to the browser. A framed
// page also reports its content height, measured as the server measures it,
// so its client can fit the frame to the page. `t3.send(text)` posts a
// `ui/message` to the client (the parent frame, or the WebView bridge on
// mobile) and settles when the client answers; it refuses outside a click or
// key press, and where no client listens, such as the headless preview.
const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("t3-theme"),n=0;if(!s)return;var b=${JSON.stringify(BASE_CSS)};function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+b;}try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){a(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}var q={};window.addEventListener("message",function(e){var d=e.data,p=d&&d.params,c;if(d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&p&&p.styles)a({appearance:p.theme,variables:p.styles.variables});if(d&&d.jsonrpc==="2.0"&&e.source===window.parent&&typeof d.id==="string"&&q[d.id]){c=q[d.id];delete q[d.id];if(d.error)c[1](new Error(String(d.error.message||"The message was not sent.")));else c[0]();}});window.t3={send:function(t){return new Promise(function(r,j){var w=window.ReactNativeWebView,u=navigator.userActivation,i,m;if(typeof t!=="string"||!t.trim())return j(new Error("t3.send needs text."));if(u&&!u.isActive)return j(new Error("t3.send works only from a click or key press."));if(window.parent===window&&!w)return j(new Error("Messages are not available here."));i="t3-message-"+(++n);m={jsonrpc:"2.0",id:i,method:${JSON.stringify(MESSAGE_METHOD)},params:{role:"user",content:[{type:"text",text:t}]}};q[i]=[r,j];if(window.parent!==window)window.parent.postMessage(m,"*");else w.postMessage(JSON.stringify(m));});}};document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;if(window.parent!==window){e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"t3-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href}},"*");}else{l.setAttribute("target","_blank");l.setAttribute("rel","noopener");}},true);if(window.parent!==window){var h,o,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:v}},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);}})();`;

function bootstrapMarkup(markup: string): string {
  const dark = htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark");
  const light = htmlRenderTheme(T3_CODE_LIGHT_THEME_COLORS, "light");
  // Without a client-provided theme (a direct download, the headless preview
  // without a fragment) the page follows the OS appearance.
  const defaultCss = `${rootRule(dark)}@media (prefers-color-scheme: light){${rootRule(light)}}${BASE_CSS}`;
  return [
    /<meta\s[^>]*charset/i.test(markup.slice(0, 4096)) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(markup)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="t3-theme">${defaultCss}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
  ].join("");
}

// Comments, raw text, and template contents are blanked to the same length,
// so offsets still line up and inert tags cannot receive the bootstrap.
const blankNonMarkup = (html: string) => {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length),
  );
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index;
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length;
      parts.push(scan.slice(at, start), " ".repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), " ".repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  return parts.join("");
};

/**
 * Inserts the theme bootstrap at the start of the document head, so a page's
 * own styles and scripts come after it.
 */
export function injectHtmlRenderBootstrap(html: string): string {
  const scan = blankNonMarkup(html);
  const markup = bootstrapMarkup(scan);
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}
