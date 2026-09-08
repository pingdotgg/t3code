export const prerender = false;

/**
 * Binary (non-HTML, non-JSON) endpoint response: a fixed byte payload with an
 * explicit content type, exercising binary bodies through workerd (dev) and
 * the Worker (live).
 */
const BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

export function GET() {
  return new Response(BYTES, {
    headers: {
      "content-type": "application/octet-stream",
      "x-binary-length": String(BYTES.length),
    },
  });
}
