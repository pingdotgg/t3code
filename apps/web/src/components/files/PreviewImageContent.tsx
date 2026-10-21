import { useState } from "react";
import { ExpandedImageDialog } from "~/components/chat/ExpandedImageDialog";
import { AttachmentImage } from "../media/AttachmentImage";

import { FileSurfaceFailure } from "./fileSurfaceChrome";

export default function PreviewImageContent(props: {
  readonly src: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly onError?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  if (failed) return <FileSurfaceFailure message="Unable to load image." />;
  return (
    <>
      <button
        type="button"
        aria-label={`Zoom ${props.name}`}
        className="flex min-h-0 flex-1 cursor-zoom-in items-center justify-center overflow-hidden p-4"
        onClick={() => setExpanded(true)}
      >
        <AttachmentImage
          name={props.name}
          mimeType={props.mimeType}
          src={props.src}
          alt={props.name}
          className="max-h-full max-w-full object-contain"
          onError={() => {
            setFailed(true);
            props.onError?.();
          }}
        />
      </button>
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
