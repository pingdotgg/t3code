import DOMPurify from "dompurify";
import { MinusIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { FileSurfaceAction } from "./fileSurfaceChrome";
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
    ALLOWED_ATTR: ["src", "alt", "colspan", "rowspan", "data-odf-whitespace"],
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

function documentColors() {
  const style = getComputedStyle(document.documentElement);
  return ["background", "foreground", "card", "border"].map((token) =>
    style.getPropertyValue(`--${token}`),
  );
}

export default function DocumentPages(props: {
  readonly html: string;
  readonly name: string;
  readonly output?: boolean;
  readonly details?: string;
}) {
  const { theme, resolvedTheme, themeHalves } = useTheme();
  const [colors, setColors] = useState(documentColors);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read the host DOM's applied theme tokens so the sandboxed document receives the current palette.
  useEffect(() => {
    // The iframe cannot inherit the host palette across its sandbox boundary.
    // oxlint-disable-next-line react/set-state-in-effect -- Read tokens after useTheme applies the selected palette.
    setColors(documentColors());
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Theme values invalidate the palette read from the host DOM.
  }, [theme, resolvedTheme, themeHalves]);
  const [zoom, setZoom] = useState(1);
  const [outputHeight, setOutputHeight] = useState(0);
  const stopObserving = useRef<(() => void) | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Disconnect the iframe body's resize observer when the document unmounts.
  useEffect(() => () => stopObserving.current?.(), []);
  const html = sanitizeDocumentHtml(props.html);
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>:root{color-scheme:${resolvedTheme}}html{background:${colors[0]};color:${colors[1]};font:${15 * zoom}px/1.65 system-ui,sans-serif}body{box-sizing:border-box;margin:${props.output ? "0" : "20px auto"};padding:${props.output ? "16px" : "32px"};width:${props.output ? "100%" : "calc(100% - 40px)"};max-width:${860 * zoom}px;min-height:${props.output ? "0" : "calc(100vh - 40px)"};display:flow-root;background:${colors[2]};overflow-wrap:anywhere}h1,h2,h3{line-height:1.25}img{max-width:100%;height:auto}table{border-collapse:collapse;min-width:100%;max-width:100%}td,th{border:1px solid ${colors[3]};padding:6px 12px;text-align:left}th{background:${colors[0]}}tr:nth-child(even){background:${colors[0]}}pre,span[data-odf-whitespace]{white-space:pre-wrap}*{scrollbar-width:thin}${props.output ? "" : "@media(max-width:420px){body{padding:20px;width:calc(100% - 24px);margin:12px auto}}"}</style></head><body>${html}</body></html>`;
  return (
    <>
      {!props.output ? (
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-3 py-1 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 text-muted-foreground tabular-nums" role="status">
            {props.details}
          </span>
          <FileSurfaceAction
            label="Decrease reading size"
            disabled={zoom <= 0.5}
            onPress={() => setZoom((value) => Math.max(0.5, value - 0.25))}
          >
            <MinusIcon className="size-3.5" />
          </FileSurfaceAction>
          <span className="min-w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <FileSurfaceAction
            label="Increase reading size"
            disabled={zoom >= 2}
            onPress={() => setZoom((value) => Math.min(2, value + 0.25))}
          >
            <PlusIcon className="size-3.5" />
          </FileSurfaceAction>
          <FileSurfaceAction
            label="Reset reading size"
            disabled={zoom === 1}
            onPress={() => setZoom(1)}
          >
            <RotateCcwIcon className="size-3.5" />
          </FileSurfaceAction>
        </div>
      ) : null}
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
    </>
  );
}
