import { describe, expect, it } from "vite-plus/test";

import { readModelBytes } from "./modelViewerData";

const response = (status: number, bytes: ReadonlyArray<number> | number) =>
  new Response(typeof bytes === "number" ? new ArrayBuffer(bytes) : Uint8Array.from(bytes).buffer, {
    status,
  });

describe("readModelBytes", () => {
  it("reads the body and fails past the limit or on an error status", async () => {
    const signal = new AbortController().signal;
    expect(await readModelBytes(response(200, [1, 2, 3]), 8, signal)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await expect(readModelBytes(response(404, 0), 8, signal)).rejects.toThrow(
      "The file could not be loaded.",
    );
    await expect(readModelBytes(response(200, 9), 8, signal)).rejects.toThrow(
      "This file is too large for the 3D view.",
    );
  });
});
