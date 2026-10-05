// Two 18x10 pixel-art gallop frames side by side; `running-cat` steps between them.
const RUNNING_CAT_FRAMES =
  "M14 0h1v1h-1zM16 0h1v1h-1zM0 1h1v1h-1zM14 1h4v1h-4zM1 2h1v1h-1zM13 2h5v1h-5zM1 3h1v1h-1zM4 3h10v1h-10zM15 3h3v1h-3zM2 4h15v1h-15zM2 5h13v1h-13zM2 6h12v1h-12zM1 7h2v1h-2zM12 7h2v1h-2zM0 8h2v1h-2zM13 8h2v1h-2zM0 9h1v1h-1zM14 9h2v1h-2z" +
  "M32 0h1v1h-1zM34 0h1v1h-1zM32 1h4v1h-4zM18 2h1v1h-1zM31 2h5v1h-5zM18 3h1v1h-1zM22 3h10v1h-10zM33 3h3v1h-3zM19 4h16v1h-16zM20 5h13v1h-13zM20 6h12v1h-12zM22 7h2v1h-2zM28 7h2v1h-2zM23 8h2v1h-2zM27 8h2v1h-2zM24 9h1v1h-1zM27 9h1v1h-1z";

/** Stands in for the "Running cat" label while an agent runs `cat`. */
export function RunningCat({ label }: { label: string }) {
  return (
    <span className="running-cat" role="img" aria-label={label}>
      <svg aria-hidden viewBox="0 0 36 10" shapeRendering="crispEdges">
        <path d={RUNNING_CAT_FRAMES} fill="currentColor" />
      </svg>
    </span>
  );
}
