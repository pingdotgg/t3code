import { pinchFileZoom } from "./fileZoom";
import { FileZoomControls, FILE_ZOOM_TOOLBAR_CLASS } from "./FileZoomControls";
import { useEffect, useRef, useState } from "react";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import { readBoundedDocument } from "./readBoundedDocument";

const bridge = `(() => {
 let zoom = 1;
 const apply = (next, x = innerWidth / 2, y = innerHeight / 2) => {
  next = Math.min(5, Math.max(.25, next));
  const left = scrollX, top = scrollY;
  const root = document.documentElement;
  if (zoom === 1) root.style.width = innerWidth + 'px';
  root.style.zoom = String(next);
  scrollTo((left + x) * next / zoom - x, (top + y) * next / zoom - y);
  zoom = next;
  parent.postMessage({type:'t3-file-zoom', zoom}, '*');
 };
 addEventListener('wheel', e => {
  if (!e.ctrlKey || !e.deltaY) return;
  e.preventDefault();
  const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
  apply((${pinchFileZoom.toString()})(zoom, Math.exp(-delta * .01), .25, 5), e.clientX, e.clientY);
 }, {passive:false});
 addEventListener('message', e => {
  if (e.source === parent && e.data?.type === 't3-file-set-zoom' && Number.isFinite(e.data.zoom)) apply(e.data.zoom);
 });
})();`;

export function FileHtmlPreview(props: { src: string; title: string }) {
  const [src] = useState(props.src);
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const frame = useRef<HTMLIFrameElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Load the bounded HTML once and install a zoom bridge inside its opaque sandbox.
  useEffect(() => {
    const controller = new AbortController();
    void readBoundedDocument(src, controller.signal, 16 * 1024 * 1024)
      .then((bytes) => {
        const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "text/html");
        if (!doc.querySelector("base")) {
          const base = doc.createElement("base");
          base.href = new URL(src, location.href).href;
          doc.head.prepend(base);
        }
        const script = doc.createElement("script");
        script.textContent = bridge;
        doc.head.prepend(script);
        if (!controller.signal.aborted) setHtml("<!doctype html>" + doc.documentElement.outerHTML);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [src]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Receive only zoom status from this exact sandboxed document window.
  useEffect(() => {
    const status = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== "t3-file-zoom")
        return;
      const value: unknown = event.data.zoom;
      if (typeof value === "number" && Number.isFinite(value))
        setZoom(Math.min(5, Math.max(0.25, value)));
    };
    window.addEventListener("message", status);
    return () => window.removeEventListener("message", status);
  }, []);
  const changeZoom = (value: number) =>
    frame.current?.contentWindow?.postMessage({ type: "t3-file-set-zoom", zoom: value }, "*");
  if (error) return <FileSurfaceFailure message="Unable to load HTML preview." />;
  if (!html) return <FileSurfaceLoading />;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={FILE_ZOOM_TOOLBAR_CLASS}>
        <span className="mr-auto" />
        <FileZoomControls
          zoom={zoom}
          min={0.25}
          max={5}
          onChange={changeZoom}
          onReset={() => changeZoom(1)}
        />
      </div>
      <iframe
        ref={frame}
        src={src}
        srcDoc={html}
        title={props.title}
        className="min-h-0 flex-1 border-0"
        sandbox="allow-scripts allow-forms allow-popups allow-downloads"
      />
    </div>
  );
}
