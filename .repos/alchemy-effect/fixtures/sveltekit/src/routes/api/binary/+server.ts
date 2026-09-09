import type { RequestHandler } from "./$types";

/**
 * Binary response path: a 256-byte ramp (0..255) served as an octet stream.
 * Exercises non-text response bodies through the worker shim, the workerd
 * re-bundle, and kit's Node dev SSR alike.
 */
export const GET: RequestHandler = () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = i;
  }
  return new Response(bytes, {
    headers: {
      "content-type": "application/octet-stream",
      "x-binary-length": String(bytes.byteLength),
    },
  });
};
