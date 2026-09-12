import DOMPurify from "dompurify";

const MAX_HTML_LENGTH = 100_000;
export const MAX_VISUALIZATION_HEIGHT = 10_000;
const POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'";

// Only these immutable bridges can execute. Keep their CSP hashes in sync when editing.
const MEASURE_SCRIPT = `(() => {
  const theme = document.createElement('style');
  document.head.append(theme);
  addEventListener('message', (event) => {
    const data = event.data;
    if (event.source === parent && data !== null && typeof data === 'object' && data.type === 't3-visualization-theme' && typeof data.css === 'string' && data.css.length <= 16000) theme.textContent = ':root{' + data.css + '}';
  });
  const send = parent.postMessage.bind(parent);
  const observe = ResizeObserver;
  const schedule = window.setTimeout.bind(window);
  const ceil = Math.ceil;
  const min = Math.min;
  const max = Math.max;
  addEventListener('DOMContentLoaded', () => {
    const content = document.body;
    let pending = false;
    let previous = 0;
    const measure = () => {
      if (pending) return;
      pending = true;
      schedule(() => {
        pending = false;
        const height = min(10000, max(1, ceil(content.getBoundingClientRect().height)));
        if (height === previous) return;
        previous = height;
        send({ type: 't3-visualization-height', height }, '*');
      }, 50);
    };
    new observe(measure).observe(content);
    addEventListener('resize', measure);
    measure();
  }, { once: true });
})();`;
const RELAY_SCRIPT = `(() => {
  const theme = document.createElement('style');
  document.head.append(theme);
  const send = parent.postMessage.bind(parent);
  const finite = Number.isFinite;
  addEventListener('DOMContentLoaded', () => {
    const content = document.body.firstElementChild;
    addEventListener('message', (event) => {
      const data = event.data;
      if (event.source === parent && data !== null && typeof data === 'object' && data.type === 't3-visualization-theme' && typeof data.css === 'string' && data.css.length <= 16000) {
        theme.textContent = ':root{' + data.css + '}';
        content.contentWindow.postMessage({ type: 't3-visualization-theme', css: data.css }, '*');
        return;
      }
      if (event.source !== content.contentWindow || data === null || typeof data !== 'object' || data.type !== 't3-visualization-height' || typeof data.height !== 'number' || !finite(data.height) || data.height < 1 || data.height > 10000) return;
      send({ type: 't3-visualization-height', height: data.height }, '*');
    });
  }, { once: true });
})();`;
const MEASURE_HASH = "'sha256-vHywAwkJBVNM9haxdbpCBTGVP8q60pgy+skng9yETwc='";
const RELAY_HASH = "'sha256-pO9pImNqi1q9JfqcpZtUGxwPkFw/9ZcMOK+UTNpEDtI='";

export function parseVisualizationHeight(data: unknown): number | null {
  if (
    typeof data !== "object" ||
    data === null ||
    !("type" in data) ||
    data.type !== "t3-visualization-height" ||
    !("height" in data)
  )
    return null;
  const height = data.height;
  return typeof height === "number" &&
    Number.isFinite(height) &&
    height >= 1 &&
    height <= MAX_VISUALIZATION_HEIGHT
    ? height
    : null;
}

function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** The trusted outer frame's frame-src policy blocks the inner frame's self-navigation. */
export function visualizationDocument(html: string, dark: boolean, themeCSS = ""): string {
  // Resource hints bypass CSP in some browsers; nested documents can hide more hints.
  // DOMPurify parses inertly and handles HTML/SVG reparsing and template contents.
  if (!DOMPurify.isSupported) return "";
  const sanitized = DOMPurify.sanitize(html, {
    FORCE_BODY: true,
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["link", "iframe", "frame", "frameset", "object", "embed", "base", "meta"],
    FORBID_ATTR: [
      "href",
      "xlink:href",
      "src",
      "srcset",
      "action",
      "formaction",
      "ping",
      "autofocus",
    ],
  });
  const head = (hashes: string) =>
    `<meta http-equiv="Content-Security-Policy" content="${POLICY}; script-src ${hashes}"><meta name="referrer" content="no-referrer">`;
  // CSS escapes prevent a theme value from terminating its style element.
  const theme = themeCSS.replaceAll("<", "\\3c ");
  const content = `<!doctype html><html><head>${head(MEASURE_HASH)}<style>:root{color-scheme:${dark ? "dark" : "light"};font:14px/1.5 system-ui;color:var(--foreground,CanvasText);${theme}}html{overflow-x:hidden}html,body{margin:0!important;padding:0!important;background:transparent!important}body{display:flow-root!important;height:auto!important;min-height:0!important;font:inherit;color:inherit;overflow-wrap:anywhere}*,*::before,*::after{box-sizing:border-box}</style><script>${MEASURE_SCRIPT}</script></head><body>${sanitized}</body></html>`;
  // srcdoc inherits the outer CSP, so its policy must authorize the measurement hash too.
  return `<!doctype html><html><head>${head(`${MEASURE_HASH} ${RELAY_HASH}`)}<style>:root{color-scheme:${dark ? "dark" : "light"};${theme}}html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block;background:transparent;overflow:hidden}</style><script>${RELAY_SCRIPT}</script></head><body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="Visualization content" srcdoc="${escapeAttribute(content)}"></iframe></body></html>`;
}

/** Only an explicitly closed, top-level visualization fence opts into rendering. */
export function isHtmlVisualizationFence(source: string, html: string): boolean {
  if (html.length > MAX_HTML_LENGTH) return false;
  const lines = source.split(/\r?\n/);
  const opening = /^ {0,3}(`{3,}|~{3,})t3-html(?:[ \t].*)?$/.exec(lines[0] ?? "");
  if (!opening) return false;
  const fence = opening[1]!;
  const closing = /^ {0,3}([`~]+)[ \t]*$/.exec(lines.at(-1) ?? "")?.[1];
  return (
    closing !== undefined &&
    closing.length >= fence.length &&
    [...closing].every((character) => character === fence[0])
  );
}
