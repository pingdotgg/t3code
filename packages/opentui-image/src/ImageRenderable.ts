import {
  CliRenderEvents,
  Renderable,
  type CliRenderer,
  type OptimizedBuffer,
  type RenderableOptions,
  type RenderContext,
} from "@opentui/core";

import { getKittyImageManager, type KittyImageManager } from "./KittyImageManager.ts";
import { assertRgbaImage } from "./kittyProtocol.ts";

const DEFAULT_CELL_WIDTH = 18;
const DEFAULT_CELL_HEIGHT = 35;

export interface ImageOptions extends Omit<
  RenderableOptions<ImageRenderable>,
  "width" | "height" | "buffered"
> {
  data: Uint8Array;
  imageWidth: number;
  imageHeight: number;
  /** Explicit terminal-cell width. By default it is derived from pixel resolution. */
  columns?: number;
  /** Explicit terminal-cell height. By default it is derived from pixel resolution. */
  rows?: number;
  fallbackCellWidth?: number;
  fallbackCellHeight?: number;
}

export class ImageRenderable extends Renderable {
  readonly #renderer: CliRenderer;
  readonly #manager: KittyImageManager;
  readonly #resizeHandler: () => void;
  #data: Uint8Array;
  #imageWidth: number;
  #imageHeight: number;
  #columns: number | undefined;
  #rows: number | undefined;
  #fallbackCellWidth: number;
  #fallbackCellHeight: number;
  #revision = 0;

  constructor(ctx: RenderContext, options: ImageOptions) {
    assertRgbaImage(options.data, options.imageWidth, options.imageHeight);
    const renderer = ctx as CliRenderer;
    const size = resolveCellSize(renderer, options);
    super(ctx, { ...options, width: size.columns, height: size.rows, buffered: false });
    this.#renderer = renderer;
    this.#manager = getKittyImageManager(renderer);
    this.#data = options.data;
    this.#imageWidth = options.imageWidth;
    this.#imageHeight = options.imageHeight;
    this.#columns = options.columns;
    this.#rows = options.rows;
    this.#fallbackCellWidth = options.fallbackCellWidth ?? DEFAULT_CELL_WIDTH;
    this.#fallbackCellHeight = options.fallbackCellHeight ?? DEFAULT_CELL_HEIGHT;
    this.#resizeHandler = () => this.#updateCellSize();
    renderer.on(CliRenderEvents.RESIZE, this.#resizeHandler);
  }

  get data(): Uint8Array {
    return this.#data;
  }

  set data(value: Uint8Array) {
    if (!(value instanceof Uint8Array)) throw new TypeError("data must be a Uint8Array");
    this.#data = value;
    this.invalidate();
  }

  get imageWidth(): number {
    return this.#imageWidth;
  }

  set imageWidth(value: number) {
    assertDimension(value, "imageWidth");
    if (this.#imageWidth === value) return;
    this.#imageWidth = value;
    this.#updateCellSize();
    this.invalidate();
  }

  get imageHeight(): number {
    return this.#imageHeight;
  }

  set imageHeight(value: number) {
    assertDimension(value, "imageHeight");
    if (this.#imageHeight === value) return;
    this.#imageHeight = value;
    this.#updateCellSize();
    this.invalidate();
  }

  get columns(): number | undefined {
    return this.#columns;
  }

  set columns(value: number | undefined) {
    assertOptionalDimension(value, "columns");
    if (this.#columns === value) return;
    this.#columns = value;
    this.#updateCellSize();
    this.invalidate();
  }

  get rows(): number | undefined {
    return this.#rows;
  }

  set rows(value: number | undefined) {
    assertOptionalDimension(value, "rows");
    if (this.#rows === value) return;
    this.#rows = value;
    this.#updateCellSize();
    this.invalidate();
  }

  /** Mark an in-place RGBA mutation as a new image revision. */
  invalidate(): void {
    this.#revision += 1;
    this.requestRender();
  }

  protected override renderSelf(_buffer: OptimizedBuffer, _deltaTime: number): void {
    assertRgbaImage(this.#data, this.#imageWidth, this.#imageHeight);
    const visible = this.#visibleImageRect();
    if (!visible) return;
    this.#manager.submit({
      key: this.num,
      revision: this.#revision,
      x: visible.x,
      y: visible.y,
      imageWidth: this.#imageWidth,
      imageHeight: this.#imageHeight,
      sourceX: visible.sourceX,
      sourceY: visible.sourceY,
      sourceWidth: visible.sourceWidth,
      sourceHeight: visible.sourceHeight,
      columns: visible.columns,
      rows: visible.rows,
      data: this.#data,
    });
  }

  protected override destroySelf(): void {
    this.#renderer.off(CliRenderEvents.RESIZE, this.#resizeHandler);
    super.destroySelf();
  }

  #updateCellSize(): void {
    const size = resolveCellSize(this.#renderer, {
      imageWidth: this.#imageWidth,
      imageHeight: this.#imageHeight,
      columns: this.#columns,
      rows: this.#rows,
      fallbackCellWidth: this.#fallbackCellWidth,
      fallbackCellHeight: this.#fallbackCellHeight,
    });
    this.width = size.columns;
    this.height = size.rows;
  }

  /**
   * Kitty placements are external to OpenTUI's cell buffer, so they do not
   * inherit its scissor stack. Recreate the effective ancestor clip and map the
   * visible cell rectangle back to source pixels before submitting a placement.
   */
  #visibleImageRect(): VisibleImageRect | null {
    const imageRect = {
      x: this.screenX,
      y: this.screenY,
      width: this.width,
      height: this.height,
    };
    let clip: CellRect | null = {
      x: 0,
      y: 0,
      width: this.#renderer.width,
      height: this.#renderer.height,
    };
    for (let ancestor = this.parent; ancestor && clip; ancestor = ancestor.parent) {
      if (ancestor.overflow === "visible") continue;
      clip = intersectCellRects(clip, {
        x: ancestor.screenX,
        y: ancestor.screenY,
        width: ancestor.width,
        height: ancestor.height,
      });
    }
    const visible = clip ? intersectCellRects(imageRect, clip) : null;
    if (!visible) return null;

    const leftCells = visible.x - imageRect.x;
    const topCells = visible.y - imageRect.y;
    const rightCells = leftCells + visible.width;
    const bottomCells = topCells + visible.height;
    const sourceX = Math.floor((leftCells / imageRect.width) * this.#imageWidth);
    const sourceY = Math.floor((topCells / imageRect.height) * this.#imageHeight);
    const sourceRight = Math.ceil((rightCells / imageRect.width) * this.#imageWidth);
    const sourceBottom = Math.ceil((bottomCells / imageRect.height) * this.#imageHeight);

    return {
      x: visible.x,
      y: visible.y,
      columns: visible.width,
      rows: visible.height,
      sourceX,
      sourceY,
      sourceWidth: Math.max(1, sourceRight - sourceX),
      sourceHeight: Math.max(1, sourceBottom - sourceY),
    };
  }
}

interface CellRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface VisibleImageRect {
  readonly x: number;
  readonly y: number;
  readonly columns: number;
  readonly rows: number;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

function intersectCellRects(left: CellRect, right: CellRect): CellRect | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  if (rightEdge <= x || bottomEdge <= y) return null;
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

interface CellSizeOptions {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  readonly fallbackCellWidth?: number;
  readonly fallbackCellHeight?: number;
}

function resolveCellSize(
  renderer: Pick<CliRenderer, "resolution" | "width" | "height">,
  options: CellSizeOptions,
): { columns: number; rows: number } {
  assertOptionalDimension(options.columns, "columns");
  assertOptionalDimension(options.rows, "rows");
  const fallbackCellWidth = options.fallbackCellWidth ?? DEFAULT_CELL_WIDTH;
  const fallbackCellHeight = options.fallbackCellHeight ?? DEFAULT_CELL_HEIGHT;
  assertDimension(fallbackCellWidth, "fallbackCellWidth");
  assertDimension(fallbackCellHeight, "fallbackCellHeight");

  const cellWidth = renderer.resolution
    ? renderer.resolution.width / renderer.width
    : fallbackCellWidth;
  const cellHeight = renderer.resolution
    ? renderer.resolution.height / renderer.height
    : fallbackCellHeight;
  const naturalColumns = Math.max(1, Math.ceil(options.imageWidth / cellWidth));
  const naturalRows = Math.max(1, Math.ceil(options.imageHeight / cellHeight));
  if (options.columns !== undefined && options.rows === undefined) {
    return {
      columns: options.columns,
      rows: Math.max(
        1,
        Math.round(
          (options.imageHeight / options.imageWidth) * options.columns * (cellWidth / cellHeight),
        ),
      ),
    };
  }
  if (options.rows !== undefined && options.columns === undefined) {
    return {
      columns: Math.max(
        1,
        Math.round(
          (options.imageWidth / options.imageHeight) * options.rows * (cellHeight / cellWidth),
        ),
      ),
      rows: options.rows,
    };
  }
  return {
    columns: options.columns ?? naturalColumns,
    rows: options.rows ?? naturalRows,
  };
}

function assertDimension(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertOptionalDimension(value: number | undefined, name: string): void {
  if (value !== undefined) assertDimension(value, name);
}
