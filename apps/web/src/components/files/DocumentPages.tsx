import { FileZoomControls, FILE_ZOOM_TOOLBAR_CLASS } from "./FileZoomControls";
import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "~/hooks/useTheme";
import { observeResize } from "~/lib/observeResize";
import { listenForPinch } from "./pinchZoom";

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

const MIN_READING_ZOOM = 0.5;
const MAX_READING_ZOOM = 2;

/** Reading size is a CSS variable inside the frame, so zooming never reloads the document. */
function setReadingZoom(frame: HTMLIFrameElement | null, zoom: number) {
  frame?.contentDocument?.documentElement?.style.setProperty("--reading-zoom", String(zoom));
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
  const stopPinch = useRef<(() => void) | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  // The frame applies pinch steps immediately; React state only follows for the toolbar.
  const liveZoom = useRef(1);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Disconnect the iframe body's resize observer and pinch listener when the document unmounts.
  useEffect(
    () => () => {
      stopObserving.current?.();
      stopPinch.current?.();
    },
    [],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Push toolbar reading-size changes into the loaded frame without rebuilding srcDoc.
  useEffect(() => {
    liveZoom.current = zoom;
    setReadingZoom(frame.current, zoom);
  }, [zoom]);
  const html = sanitizeDocumentHtml(props.html);
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>:root{color-scheme:${resolvedTheme}}html{background:${colors[0]};color:${colors[1]};font:15px/1.65 system-ui,sans-serif}body{zoom:var(--reading-zoom,1);box-sizing:border-box;margin:${props.output ? "0" : "20px auto"};padding:${props.output ? "16px" : "32px"};width:${props.output ? "100%" : "calc(var(--reading-width, 100vw) - 40px)"};max-width:860px;min-height:${props.output ? "0" : "calc(100vh - 40px)"};display:flow-root;background:${colors[2]};overflow-wrap:anywhere}h1,h2,h3{line-height:1.25}img{max-width:100%;height:auto}table{border-collapse:collapse;min-width:100%;max-width:100%}td,th{border:1px solid ${colors[3]};padding:6px 12px;text-align:left}th{background:${colors[0]}}tr:nth-child(even){background:${colors[0]}}pre,span[data-odf-whitespace]{white-space:pre-wrap}*{scrollbar-width:thin}${props.output ? "" : "@media(max-width:420px){body{padding:20px;width:calc(100% - 24px);margin:12px auto}}"}</style></head><body>${html}</body></html>`;
  return (
    <>
      {!props.output ? (
        <div className={FILE_ZOOM_TOOLBAR_CLASS}>
          <span className="min-w-0 flex-1 text-muted-foreground tabular-nums" role="status">
            {props.details}
          </span>
          <FileZoomControls
            zoom={zoom}
            min={MIN_READING_ZOOM}
            max={MAX_READING_ZOOM}
            onChange={setZoom}
            onReset={() => setZoom(1)}
          />
        </div>
      ) : null}
      <iframe
        title={props.name}
        srcDoc={srcDoc}
        ref={frame}
        // Same-origin access lets the parent measure output and apply pinch zoom; scripts remain blocked.
        sandbox="allow-same-origin"
        onLoad={(event) => {
          const node = event.currentTarget;
          node.contentDocument?.documentElement?.style.setProperty(
            "--reading-width",
            `${node.clientWidth}px`,
          );
          setReadingZoom(node, liveZoom.current);
          if (!props.output) {
            stopObserving.current?.();
            stopObserving.current = observeResize(node, () => {
              node.contentDocument?.documentElement?.style.setProperty(
                "--reading-width",
                `${node.clientWidth}px`,
              );
            });
            stopPinch.current?.();
            const view = node.contentWindow;
            stopPinch.current = view
              ? listenForPinch(view, (factor, point) => {
                  const previous = liveZoom.current;
                  const next = Math.min(
                    MAX_READING_ZOOM,
                    Math.max(MIN_READING_ZOOM, previous * factor),
                  );
                  if (next === previous) return;
                  liveZoom.current = next;
                  setReadingZoom(node, next);
                  // Text reflows, so keep the pointer's proportional position.
                  view.scrollTo({
                    left: (view.scrollX + point.x) * (next / previous) - point.x,
                    top: (view.scrollY + point.y) * (next / previous) - point.y,
                  });
                  setZoom(next);
                })
              : null;
            return;
          }
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
