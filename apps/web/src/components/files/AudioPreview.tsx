/** Native playback controls for a captured or workspace audio file. */
export function AudioPreview(props: {
  readonly src: string;
  readonly name: string;
  readonly onError?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <audio
        controls
        preload="metadata"
        src={props.src}
        aria-label={props.name}
        className="w-full max-w-xl"
        onError={props.onError}
      />
    </div>
  );
}
