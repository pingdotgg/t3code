import type { EpubPage } from "./officePreviewProtocol";

const mathNamespace = "http://www.w3.org/1998/Math/MathML";
let nativeFences: boolean | undefined;

export function epubSource(page: EpubPage, dark: boolean) {
  const styles =
    page.styles
      ?.map(
        ({ css, media }) =>
          `<style media="${media.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}">${css}</style>`,
      )
      .join("") ?? "";
  const layout = page.imagePage
    ? page.fixed
      ? "html,body{width:100%;height:100%;margin:0}body>img,body>svg{display:block}"
      : "body{margin:0;display:grid;place-items:center;min-height:100vh}img,svg{max-width:100vw;max-height:100vh;height:auto;object-fit:contain}"
    : "";
  return `<!doctype html><html${page.htmlAttrs ?? ""}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; font-src data:; media-src blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>@layer preview{*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}:root{color-scheme:${dark ? "dark" : "light"}}${layout}</style>${styles}</head><body${page.bodyAttrs ?? ""}>${page.html}</body></html>`;
}

export function prepareEpubDocument(doc: Document) {
  // XHTML can contain nested links, which the HTML parser would split and truncate.
  for (const placeholder of doc.querySelectorAll("epub-nested-link")) {
    const link = doc.createElement("a");
    for (const { name, value } of placeholder.attributes) link.setAttribute(name, value);
    while (placeholder.firstChild) link.append(placeholder.firstChild);
    placeholder.replaceWith(link);
  }
  // HTML inserts tbody around direct rows. XHTML styles can target those rows as table children.
  for (const body of doc.querySelectorAll(
    "table[data-epub-direct-rows] > tbody:not([data-epub-authored])",
  )) {
    const rows = doc.createDocumentFragment();
    while (body.firstChild) rows.append(body.firstChild);
    body.replaceWith(rows);
  }
  const fenced = doc.getElementsByTagNameNS(mathNamespace, "mfenced");
  if (fenced.length === 0) return;
  nativeFences ??= supportsMathFences(doc.defaultView?.frameElement?.ownerDocument ?? doc);
  if (nativeFences) return;
  for (const expression of Array.from(fenced)) expandMathFences(doc, expression);
}

function supportsMathFences(doc: Document) {
  // Chromium gives mfenced the width of its contents because it omits the delimiters.
  const math = doc.createElementNS(mathNamespace, "math");
  const fenced = doc.createElementNS(mathNamespace, "mfenced");
  const argument = doc.createElementNS(mathNamespace, "mi");
  argument.textContent = "x";
  math.style.cssText = "position:fixed;visibility:hidden;font-size:16px";
  fenced.append(argument);
  math.append(fenced);
  doc.body.append(math);
  const supported = fenced.getBoundingClientRect().width > argument.getBoundingClientRect().width;
  math.remove();
  return supported;
}

function expandMathFences(doc: Document, expression: Element) {
  const row = doc.createElementNS(mathNamespace, "mrow");
  for (const { name, value } of expression.attributes) row.setAttribute(name, value);
  const appendOperator = (
    target: Element,
    text: string,
    kind: "fence" | "separator",
    form: string,
  ) => {
    if (!text) return;
    const operator = doc.createElementNS(mathNamespace, "mo");
    operator.setAttribute(kind, "true");
    operator.setAttribute("form", form);
    operator.textContent = text;
    target.append(operator);
  };
  const open = (expression.getAttribute("open") ?? "(").replace(/[\t\n\r ]+/g, " ").trim();
  const close = (expression.getAttribute("close") ?? ")").replace(/[\t\n\r ]+/g, " ").trim();
  const separators = [...(expression.getAttribute("separators") ?? ",").replace(/[\t\n\r ]/g, "")];
  appendOperator(row, open, "fence", "prefix");
  const args = Array.from(expression.children);
  const contents = args.length > 1 ? doc.createElementNS(mathNamespace, "mrow") : row;
  for (const [index, child] of args.entries()) {
    const separator = separators[Math.min(index - 1, separators.length - 1)];
    if (separator) appendOperator(contents, separator, "separator", "infix");
    contents.append(child);
  }
  if (contents !== row) row.append(contents);
  appendOperator(row, close, "fence", "postfix");
  expression.replaceWith(row);
}
