import type { GameDevCapture } from "@t3tools/contracts";

export function GameCaptureImage({
  capture,
  label,
}: {
  readonly capture: GameDevCapture;
  readonly label: string;
}) {
  return (
    <img
      className="max-h-80 w-full rounded-md bg-muted object-contain"
      alt={label}
      src={`data:${capture.mimeType};base64,${capture.dataBase64}`}
    />
  );
}
