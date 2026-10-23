import { useState } from "react";

export function AudioPreview(props: {
  readonly src: string;
  readonly name: string;
  /** Re-signed URLs with the same revision keep the loaded audio and its position. */
  readonly revision?: string | null;
  readonly onError?: () => void;
}) {
  const [loadedSource, setLoadedSource] = useState<{ src: string; revision: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const revision = props.revision ?? null;
  // Changed files load once playback pauses.
  if (loadedSource !== null && loadedSource.revision !== revision && !playing) {
    setLoadedSource(revision === null ? null : { src: props.src, revision });
  }
  const src = loadedSource?.src ?? props.src;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <audio
        controls
        preload="metadata"
        src={src}
        aria-label={props.name}
        className="w-full max-w-xl"
        onLoadedMetadata={() => {
          if (revision !== null && loadedSource === null) setLoadedSource({ src, revision });
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setPlaying(false);
          setLoadedSource(null);
          if (src === props.src) props.onError?.();
        }}
      />
    </div>
  );
}
