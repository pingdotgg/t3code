import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "~/hooks/useTheme";
import { observeResize } from "~/lib/observeResize";

export function sanitizeDocumentHtml(source: string): string {
  const fragment = DOMPurify.sanitize(source, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "div",
      "span",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "caption",
      "figure",
      "figcaption",
      "br",
      "hr",
      "sub",
      "sup",
      "dl",
      "dt",
      "dd",
      "img",
    ],
    ALLOWED_ATTR: ["src", "alt", "colspan", "rowspan"],
  });
  for (const image of fragment.querySelectorAll("img")) {
    if (
      !/^data:image\/(png|jpeg|gif|webp);base64,[a-z\d+/]*={0,2}$/i.test(
        image.getAttribute("src") ?? "",
      )
    )
      image.remove();
  }
  const container = document.createElement("div");
  container.append(fragment);
  return container.innerHTML;
}

export default function DocumentPages(props: {
  readonly html: string;
  readonly name: string;
  readonly output?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const [outputHeight, setOutputHeight] = useState(0);
  const stopObserving = useRef<(() => void) | null>(null);
  useEffect(() => () => stopObserving.current?.(), []);
  const dark = resolvedTheme === "dark";
  const html = sanitizeDocumentHtml(props.html);
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>:root{color-scheme:${resolvedTheme}}html{background:${dark ? "#141414" : "#f4f4f5"};color:${dark ? "#e4e4e7" : "#27272a"};font:15px/1.65 system-ui,sans-serif}body{box-sizing:border-box;margin:${props.output ? "0" : "20px auto"};padding:${props.output ? "16px" : "32px"};width:${props.output ? "100%" : "calc(100% - 40px)"};max-width:860px;min-height:${props.output ? "0" : "calc(100vh - 40px)"};display:flow-root;background:${dark ? "#202020" : "white"};overflow-wrap:anywhere}h1,h2,h3{line-height:1.25}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid ${dark ? "#52525b" : "#d4d4d8"};padding:6px 12px;text-align:left}pre{white-space:pre-wrap}*{scrollbar-width:thin}${props.output ? "" : "@media(max-width:420px){body{padding:20px;width:calc(100% - 24px);margin:12px auto}}"}</style></head><body>${html}</body></html>`;
  return (
    <iframe
      title={props.name}
      srcDoc={srcDoc}
      // Same-origin access lets the parent measure saved output; scripts remain blocked.
      sandbox={props.output ? "allow-same-origin" : ""}
      onLoad={(event) => {
        if (!props.output) return;
        stopObserving.current?.();
        const body = event.currentTarget.contentDocument?.body;
        if (!body) return;
        const measure = () => setOutputHeight(Math.ceil(body.getBoundingClientRect().height));
        stopObserving.current = observeResize(body, measure);
        measure();
      }}
      style={props.output ? { height: outputHeight } : undefined}
      className={props.output ? "block w-full border-0" : "min-h-0 flex-1 border-0"}
    />
  );
}
