import { Image, type RgbaImage } from "@t3tools/opentui-image/react";
import { useRenderer } from "@opentui/react";
import * as React from "react";

import { clip } from "../format.ts";
import { deferMouseAction } from "../mouse.ts";
import { usePalette } from "../theme.ts";

const FALLBACK_CELL_WIDTH = 18;
const FALLBACK_CELL_HEIGHT = 35;

export interface ExpandedImagePreview {
  readonly name: string;
  readonly sizeBytes: number;
  readonly image: RgbaImage;
}

export function fitImageToCells(input: {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly maxColumns: number;
  readonly maxRows: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
}): { readonly columns: number; readonly rows: number } {
  const maxColumns = Math.max(1, Math.floor(input.maxColumns));
  const maxRows = Math.max(1, Math.floor(input.maxRows));
  const cellWidth = input.cellWidth > 0 ? input.cellWidth : FALLBACK_CELL_WIDTH;
  const cellHeight = input.cellHeight > 0 ? input.cellHeight : FALLBACK_CELL_HEIGHT;
  let columns = maxColumns;
  let rows = Math.max(
    1,
    Math.round((input.imageHeight / input.imageWidth) * columns * (cellWidth / cellHeight)),
  );
  if (rows > maxRows) {
    rows = maxRows;
    columns = Math.max(
      1,
      Math.round((input.imageWidth / input.imageHeight) * rows * (cellHeight / cellWidth)),
    );
  }
  return { columns: Math.min(columns, maxColumns), rows: Math.min(rows, maxRows) };
}

export const ImageLightbox = React.memo(function ImageLightbox({
  preview,
  width,
  height,
  onClose,
}: {
  readonly preview: ExpandedImagePreview;
  readonly width: number;
  readonly height: number;
  readonly onClose: () => void;
}): React.ReactNode {
  const palette = usePalette();
  const renderer = useRenderer();
  const cellWidth = renderer.resolution
    ? renderer.resolution.width / renderer.width
    : FALLBACK_CELL_WIDTH;
  const cellHeight = renderer.resolution
    ? renderer.resolution.height / renderer.height
    : FALLBACK_CELL_HEIGHT;
  const fitted = fitImageToCells({
    imageWidth: preview.image.imageWidth,
    imageHeight: preview.image.imageHeight,
    maxColumns: width - 4,
    maxRows: height - 4,
    cellWidth,
    cellHeight,
  });
  const sizeKb = Math.max(1, Math.round(preview.sizeBytes / 1024));
  const closeHint = width >= 48 ? "Esc / click to close" : "Esc close";
  const metadataWidth = Math.max(4, width - closeHint.length - 9);
  const closeFromMouse = React.useMemo(() => deferMouseAction(onClose), [onClose]);

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      border
      borderStyle="rounded"
      borderColor={palette.accent}
      alignItems="center"
      onMouseDown={closeFromMouse}
    >
      <box width={Math.max(1, width - 4)} flexDirection="row" justifyContent="space-between">
        <text fg={palette.text}>{`${clip(preview.name, metadataWidth)} · ${sizeKb} KB`}</text>
        <text fg={palette.dim}>{closeHint}</text>
      </box>
      <box flexGrow={1} width={Math.max(1, width - 2)} alignItems="center" justifyContent="center">
        <Image
          data={preview.image.data}
          imageWidth={preview.image.imageWidth}
          imageHeight={preview.image.imageHeight}
          columns={fitted.columns}
          rows={fitted.rows}
        />
      </box>
    </box>
  );
});
