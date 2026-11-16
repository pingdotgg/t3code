import { pinchFileZoom } from "./fileZoom";
import { FileZoomControls, FILE_ZOOM_TOOLBAR_CLASS } from "./FileZoomControls";
import { useLayoutEffect, useRef, useState } from "react";
import { MaximizeIcon } from "lucide-react";
import { ExpandedImageDialog } from "~/components/chat/ExpandedImageDialog";
import { observeResize } from "~/lib/observeResize";
import { AttachmentImage } from "../media/AttachmentImage";
import { FileSurfaceAction, FileSurfaceFailure } from "./fileSurfaceChrome";
import { usePinchZoom } from "./pinchZoom";

// The image sits centered with a 16px margin inside its scroll content.
const imageOffset = (view: number, size: number) => Math.max(16, (view - size) / 2);

export default function PreviewImageContent(props: {
  readonly src: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly onError?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure the image viewport before paint and observe resizes to keep fit-to-view scaling accurate.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setViewport({ width: node.clientWidth, height: node.clientHeight });
    update();
    return observeResize(node, update);
  }, []);
  const fit = natural.width
    ? Math.min(
        1,
        Math.max(1, viewport.width - 32) / natural.width,
        Math.max(1, viewport.height - 32) / natural.height,
      )
    : 1;
  const scale = zoom ?? fit;
  // Pinch steps that arrive before React commits build on the uncommitted scale.
  const pendingScale = useRef<number | null>(null);
  const anchor = useRef<{ x: number; y: number; fx: number; fy: number } | null>(null);
  usePinchZoom(ref, (factor, point) => {
    const node = ref.current;
    if (!node || !natural.width) return;
    const previous = pendingScale.current ?? scale;
    const next = pinchFileZoom(previous, factor, 0.05, 8);
    if (next === previous) return;
    const width = natural.width * scale;
    const height = natural.height * scale;
    anchor.current = {
      ...point,
      fx: (node.scrollLeft + point.x - imageOffset(node.clientWidth, width)) / width,
      fy: (node.scrollTop + point.y - imageOffset(node.clientHeight, height)) / height,
    };
    pendingScale.current = next;
    setZoom(next);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the image point under the pointer fixed once the new size has committed to layout.
  useLayoutEffect(() => {
    pendingScale.current = null;
    const point = anchor.current;
    anchor.current = null;
    const node = ref.current;
    if (!point || !node) return;
    const width = natural.width * scale;
    const height = natural.height * scale;
    node.scrollTo({
      left: imageOffset(node.clientWidth, width) + point.fx * width - point.x,
      top: imageOffset(node.clientHeight, height) + point.fy * height - point.y,
    });
  }, [scale, natural]);
  if (failed) return <FileSurfaceFailure message="Unable to load image." />;
  return (
    <>
      <div className={FILE_ZOOM_TOOLBAR_CLASS}>
        <span className="mr-auto px-1 tabular-nums">
          {natural.width
            ? `${natural.width.toLocaleString()} × ${natural.height.toLocaleString()}`
            : "Loading image…"}
        </span>
        <div className="flex items-center gap-1">
          <FileZoomControls
            zoom={scale}
            min={0.05}
            max={8}
            disabled={!natural.width}
            onChange={setZoom}
            onReset={() => setZoom(null)}
            resetLabel="Fit image"
          />
          <FileSurfaceAction
            label="Actual image size"
            pressed={zoom === 1}
            onPress={() => setZoom(1)}
          >
            <MaximizeIcon className="size-3.5" />
          </FileSurfaceAction>
        </div>
      </div>
      <div ref={ref} className="min-h-0 flex-1 overflow-auto">
        <div
          className="flex min-h-full min-w-full items-center justify-center p-4"
          style={{
            width: natural.width ? natural.width * scale + 32 : undefined,
            height: natural.height ? natural.height * scale + 32 : undefined,
          }}
        >
          <button
            type="button"
            aria-label={`Zoom ${props.name}`}
            className="shrink-0 cursor-zoom-in"
            onClick={() => setExpanded(true)}
          >
            <AttachmentImage
              name={props.name}
              mimeType={props.mimeType}
              src={props.src}
              alt={props.name}
              className="block max-w-none"
              style={
                natural.width
                  ? { width: natural.width * scale, height: natural.height * scale }
                  : { maxWidth: "100%" }
              }
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onError={() => {
                setFailed(true);
                props.onError?.();
              }}
            />
          </button>
        </div>
      </div>
      {expanded ? (
        <ExpandedImageDialog
          preview={{
            images: [
              {
                src: props.src,
                name: props.name,
                ...(props.mimeType ? { mimeType: props.mimeType } : {}),
              },
            ],
            index: 0,
          }}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </>
  );
}
