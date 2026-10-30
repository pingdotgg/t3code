import type { CuaWindowPreviewFrame } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

export function useComputerPreviewFrame(nextFrame: CuaWindowPreviewFrame | null) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState<CuaWindowPreviewFrame | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Decodes each streamed frame off-screen and paints it into the canvas only once it can replace the shown one.
  useEffect(() => {
    if (!nextFrame) return;
    let cancelled = false;
    const image = new Image();
    image.src = `data:${nextFrame.mimeType};base64,${nextFrame.dataBase64}`;
    void image
      .decode()
      .then(() => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        // Changing an img src can blank its previous frame while decoding.
        // Keep the canvas pixels until the replacement can be drawn in one task.
        if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
        }
        context.drawImage(image, 0, 0);
        setFrame(nextFrame);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [nextFrame]);

  return { canvasRef, frame };
}
