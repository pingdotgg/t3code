import * as NodeBuffer from "node:buffer";

const ESC = "\x1b";
const ST = `${ESC}\\`;

export type KittyProtocolTransport = "direct" | "tmux";

// Kitty recommends keeping the full APC command below 4096 bytes. Leaving
// ample room for control parameters keeps this true as ids and dimensions grow.
export const KITTY_CHUNK_SIZE = 3_072;

export interface KittyTransmitOptions {
  readonly imageId: number;
  readonly x: number;
  readonly y: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly columns: number;
  readonly rows: number;
  readonly data: Uint8Array;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export function assertRgbaImage(data: Uint8Array, imageWidth: number, imageHeight: number): void {
  assertPositiveInteger(imageWidth, "imageWidth");
  assertPositiveInteger(imageHeight, "imageHeight");
  const pixelCount = imageWidth * imageHeight;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > Number.MAX_SAFE_INTEGER / 4) {
    throw new RangeError("image dimensions are too large");
  }
  const expectedLength = pixelCount * 4;
  if (data.byteLength !== expectedLength) {
    throw new RangeError(
      `RGBA data length must be ${expectedLength} bytes for ${imageWidth}x${imageHeight}, received ${data.byteLength}`,
    );
  }
}

function encodeKittyCommand(command: string, transport: KittyProtocolTransport): string {
  if (transport === "direct") return command;
  // tmux passthrough is a DCS payload prefixed with "tmux;". Every ESC in the
  // wrapped command must be doubled so tmux forwards it instead of parsing it.
  return `${ESC}Ptmux;${command.replaceAll(ESC, ESC + ESC)}${ST}`;
}

export function encodeKittyDelete(
  imageId: number,
  transport: KittyProtocolTransport = "direct",
): string {
  assertPositiveInteger(imageId, "imageId");
  return encodeKittyCommand(`${ESC}_Ga=d,d=i,i=${imageId},q=2${ST}`, transport);
}

export function encodeKittyTransmit(
  options: KittyTransmitOptions,
  transport: KittyProtocolTransport = "direct",
): string {
  const { imageId, x, y, imageWidth, imageHeight, columns, rows, data } = options;
  assertPositiveInteger(imageId, "imageId");
  assertPositiveInteger(columns, "columns");
  assertPositiveInteger(rows, "rows");
  assertRgbaImage(data, imageWidth, imageHeight);

  const encoded = NodeBuffer.Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
    "base64",
  );
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += KITTY_CHUNK_SIZE) {
    chunks.push(encoded.slice(offset, offset + KITTY_CHUNK_SIZE));
  }
  // An RGBA image is never empty, but retaining this fallback keeps the encoder
  // total if the validation rules ever expand to permit zero-sized placeholders.
  if (chunks.length === 0) chunks.push("");

  const cursor = `${ESC}[${Math.max(0, Math.trunc(y)) + 1};${Math.max(0, Math.trunc(x)) + 1}H`;
  return (
    cursor +
    chunks
      .map((chunk, index) => {
        const more = index === chunks.length - 1 ? 0 : 1;
        if (index === 0) {
          return encodeKittyCommand(
            `${ESC}_Ga=T,f=32,s=${imageWidth},v=${imageHeight},c=${columns},r=${rows},i=${imageId},m=${more},q=2;${chunk}${ST}`,
            transport,
          );
        }
        return encodeKittyCommand(`${ESC}_Gm=${more},q=2;${chunk}${ST}`, transport);
      })
      .join("")
  );
}
