import type {
  PreviewStreamPointer,
  PreviewStreamViewport,
} from "@t3tools/client-runtime/preview/server-browser-stream";

export interface AgentCursorPlacement {
  readonly phase: PreviewStreamPointer["phase"];
  readonly sequence: number;
  readonly left: number;
  readonly top: number;
}

export function placeAgentCursor(
  pointer: PreviewStreamPointer,
  canvas: HTMLCanvasElement | null,
  viewport: PreviewStreamViewport | null,
): AgentCursorPlacement | null {
  if (!canvas || !viewport || canvas.width < 1 || canvas.height < 1) return null;
  const box = { width: canvas.clientWidth, height: canvas.clientHeight };
  const fit = Math.min(box.width / canvas.width, box.height / canvas.height);
  const width = canvas.width * fit;
  const height = canvas.height * fit;
  return {
    phase: pointer.phase,
    sequence: pointer.sequence,
    left: (box.width - width) / 2 + (pointer.x * width) / viewport.width,
    top: (box.height - height) / 2 + (pointer.y * height) / viewport.height,
  };
}
