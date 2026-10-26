import { useLayoutEffect, useRef, useState } from "react";
import { MaximizeIcon, MinusIcon, PlusIcon, ScanIcon } from "lucide-react";
import { ExpandedImageDialog } from "~/components/chat/ExpandedImageDialog";
import { observeResize } from "~/lib/observeResize";
import { AttachmentImage } from "../media/AttachmentImage";
import { FileSurfaceAction, FileSurfaceFailure } from "./fileSurfaceChrome";

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
  // oxlint-disable-next-line t3code/react-effect-budget -- Measure the image viewport before paint and observe resizes to keep fit-to-view scaling accurate.
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
  const changeZoom = (factor: number) => setZoom(Math.max(0.05, Math.min(8, scale * factor)));
  if (failed) return <FileSurfaceFailure message="Unable to load image." />;
  return (
    <>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-1 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {natural.width
            ? `${natural.width.toLocaleString()} × ${natural.height.toLocaleString()}`
            : "Loading image…"}
        </span>
        <div className="flex items-center gap-1">
          <FileSurfaceAction
            label="Zoom out"
            disabled={!natural.width || scale <= 0.05}
            onPress={() => changeZoom(1 / 1.25)}
          >
            <MinusIcon className="size-3.5" />
          </FileSurfaceAction>
          <span className="min-w-10 text-center tabular-nums">{Math.round(scale * 100)}%</span>
          <FileSurfaceAction
            label="Zoom in"
            disabled={!natural.width || scale >= 8}
            onPress={() => changeZoom(1.25)}
          >
            <PlusIcon className="size-3.5" />
          </FileSurfaceAction>
          <FileSurfaceAction
            label="Fit image"
            pressed={zoom === null}
            onPress={() => setZoom(null)}
          >
            <ScanIcon className="size-3.5" />
          </FileSurfaceAction>
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
