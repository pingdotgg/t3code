export function minimapCanvas(container: ParentNode) {
  const canvas = container.querySelector<HTMLCanvasElement>("[data-minimap-canvas]");
  if (!canvas) throw new Error("Missing minimap canvas");
  return canvas;
}

/** Sample sparse marker centers, clear of round caps and adjacent ticks. */
export function minimapMarkerPixels(container: ParentNode, count: number, railX = 4) {
  const canvas = minimapCanvas(container);
  const bounds = canvas.getBoundingClientRect();
  const context = canvas.getContext("2d");
  if (!context || bounds.width <= 0 || bounds.height <= 0 || !canvas.width || !canvas.height) {
    throw new Error("Minimap has no drawable backing");
  }
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const rail = canvas.parentElement!.getBoundingClientRect();
  // The padded backing is pixel-aligned independently of the logical rail.
  const x = Math.floor(((rail.left + railX - bounds.left) / bounds.width) * canvas.width);
  return Array.from({ length: count }, (_, index) => {
    const railY = count <= 1 ? 0 : (index / (count - 1)) * rail.height;
    const y = Math.floor(((rail.top + railY - bounds.top) / bounds.height) * canvas.height);
    const offset = (y * canvas.width + x) * 4;
    return Array.from(data.subarray(offset, offset + 4));
  });
}

export function paintedMinimapMarkerIndices(container: ParentNode, count: number) {
  // Base alpha is 25%, active alpha is 60% (at most 153). The 55%
  // highlight over either exceeds 160. Callers use sparse markers to avoid
  // antialiased overlap admitting an unselected neighbor.
  return minimapMarkerPixels(container, count).flatMap((pixel, index) =>
    pixel[3]! > 160 ? [index] : [],
  );
}
