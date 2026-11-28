import { useGT } from "gt-react";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "~/components/ui/dialog";

const localBlob = (src: string | null) => (src?.startsWith("blob:") ? src : undefined);

export function EpubMediaDialog(props: {
  readonly media: HTMLMediaElement;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const media = props.media;
  const src = localBlob(media.getAttribute("src"));
  const sources = Array.from(media.querySelectorAll("source"), (source) => (
    <source
      key={`${source.src}:${source.type}`}
      src={localBlob(source.getAttribute("src"))}
      type={source.type}
    />
  ));
  const tracks = Array.from(media.querySelectorAll("track"), (track) => (
    <track
      key={`${track.src}:${track.kind}:${track.srclang}`}
      src={localBlob(track.getAttribute("src"))}
      kind={track.kind}
      srcLang={track.srclang}
      label={track.label}
      default={track.default}
    />
  ));
  const isVideo = media.localName === "video";
  const title =
    media.title ||
    media.getAttribute("aria-label") ||
    (isVideo ? gt("Video preview") : gt("Audio preview"));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup closeButtonSize="icon-xl">
        <DialogHeader>
          <DialogTitle className="me-10">{title}</DialogTitle>
        </DialogHeader>
        <div className="px-4 pb-4">
          {isVideo ? (
            <video
              aria-label={title}
              className="max-h-[60dvh] w-full"
              controls
              playsInline
              preload="metadata"
              src={src}
              poster={localBlob(media.getAttribute("poster"))}
              muted={media.muted}
              loop={media.loop}
            >
              {sources}
              {tracks}
            </video>
          ) : (
            <audio
              aria-label={title}
              className="w-full"
              controls
              preload="metadata"
              src={src}
              muted={media.muted}
              loop={media.loop}
            >
              {sources}
              {tracks}
            </audio>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
