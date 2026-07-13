import { CliRenderEvents, type CliRenderer } from "@opentui/core";

import { assertRgbaImage, encodeKittyDelete, encodeKittyTransmit } from "./kittyProtocol.ts";

export interface KittyImageWriter {
  write(chunk: string): unknown;
}

export interface KittyImagePatch {
  readonly key: number;
  readonly revision: number;
  readonly x: number;
  readonly y: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly columns: number;
  readonly rows: number;
  readonly data: Uint8Array;
}

export interface KittyImageExtensionOptions {
  /** Use `always` only if the host independently established Kitty support. */
  readonly capability?: "auto" | "always";
  /** Defaults to `process.stdout`. Required for renderers using a custom stream. */
  readonly writer?: KittyImageWriter;
}

interface ActivePatch extends KittyImagePatch {
  readonly imageId: number;
}

const managers = new WeakMap<CliRenderer, KittyImageManager>();

export class KittyImageManager {
  readonly #renderer: CliRenderer;
  readonly #writer: KittyImageWriter;
  readonly #capability: "auto" | "always";
  readonly #pending = new Map<number, KittyImagePatch>();
  #active = new Map<number, ActivePatch>();
  #nextImageId = 1;
  #disposed = false;

  readonly #beforeFrame = async (): Promise<void> => {
    this.beginFrame();
  };

  readonly #afterFrame = (): void => {
    this.flushFrame();
  };

  readonly #onCapabilities = (): void => {
    this.#renderer.requestRender();
  };

  readonly #onDestroy = (): void => {
    this.dispose();
  };

  constructor(renderer: CliRenderer, options: KittyImageExtensionOptions = {}) {
    this.#renderer = renderer;
    this.#writer = options.writer ?? process.stdout;
    this.#capability = options.capability ?? "auto";
    renderer.setFrameCallback(this.#beforeFrame);
    renderer.on(CliRenderEvents.FRAME, this.#afterFrame);
    renderer.on(CliRenderEvents.CAPABILITIES, this.#onCapabilities);
    renderer.on(CliRenderEvents.DESTROY, this.#onDestroy);
  }

  get isSupported(): boolean {
    return this.#capability === "always" || this.#renderer.capabilities?.kitty_graphics === true;
  }

  get isDisposed(): boolean {
    return this.#disposed;
  }

  beginFrame(): void {
    if (this.#disposed) return;
    this.#pending.clear();
  }

  submit(patch: KittyImagePatch): void {
    if (this.#disposed) return;
    assertRgbaImage(patch.data, patch.imageWidth, patch.imageHeight);
    if (!Number.isSafeInteger(patch.columns) || patch.columns <= 0) {
      throw new RangeError("columns must be a positive safe integer");
    }
    if (!Number.isSafeInteger(patch.rows) || patch.rows <= 0) {
      throw new RangeError("rows must be a positive safe integer");
    }
    this.#pending.set(patch.key, patch);
  }

  flushFrame(): void {
    if (this.#disposed) return;

    if (!this.isSupported) {
      this.#deleteAllActive();
      return;
    }

    const output: string[] = [];
    const nextActive = new Map<number, ActivePatch>();

    for (const [key, active] of this.#active) {
      const pending = this.#pending.get(key);
      if (!pending || !samePatch(active, pending)) {
        output.push(encodeKittyDelete(active.imageId));
      }
    }

    for (const [key, pending] of this.#pending) {
      const active = this.#active.get(key);
      if (active && samePatch(active, pending)) {
        nextActive.set(key, active);
        continue;
      }

      const imageId = this.#allocateImageId();
      output.push(encodeKittyTransmit({ ...pending, imageId }));
      nextActive.set(key, { ...pending, imageId });
    }

    this.#active = nextActive;
    if (output.length > 0) this.#writer.write(output.join(""));
  }

  /** Remove all terminal placements without uninstalling the renderer hooks. */
  clearImages(): void {
    if (this.#disposed) return;
    this.#pending.clear();
    this.#deleteAllActive();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clearImages();
    this.#disposed = true;
    this.#pending.clear();
    this.#renderer.removeFrameCallback(this.#beforeFrame);
    this.#renderer.off(CliRenderEvents.FRAME, this.#afterFrame);
    this.#renderer.off(CliRenderEvents.CAPABILITIES, this.#onCapabilities);
    this.#renderer.off(CliRenderEvents.DESTROY, this.#onDestroy);
    managers.delete(this.#renderer);
  }

  #allocateImageId(): number {
    const imageId = this.#nextImageId;
    this.#nextImageId = imageId === 0xffff_ffff ? 1 : imageId + 1;
    return imageId;
  }

  #deleteAllActive(): void {
    if (this.#active.size > 0) {
      this.#writer.write(
        [...this.#active.values()].map(({ imageId }) => encodeKittyDelete(imageId)).join(""),
      );
      this.#active.clear();
    }
  }
}

function samePatch(active: ActivePatch, pending: KittyImagePatch): boolean {
  return (
    active.revision === pending.revision &&
    active.x === pending.x &&
    active.y === pending.y &&
    active.imageWidth === pending.imageWidth &&
    active.imageHeight === pending.imageHeight &&
    active.columns === pending.columns &&
    active.rows === pending.rows
  );
}

export function installKittyImageExtension(
  renderer: CliRenderer,
  options: KittyImageExtensionOptions = {},
): KittyImageManager {
  const existing = managers.get(renderer);
  if (existing && !existing.isDisposed) return existing;
  const manager = new KittyImageManager(renderer, options);
  managers.set(renderer, manager);
  return manager;
}

export function getKittyImageManager(renderer: CliRenderer): KittyImageManager {
  return managers.get(renderer) ?? installKittyImageExtension(renderer);
}
