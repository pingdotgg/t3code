import decoderUrl from "heic-to/csp?url";

// Emit one unchanged module so the main and worker builds share the same decoder asset.
export function loadHeicDecoder(): Promise<typeof import("heic-to/csp")> {
  return import(/* @vite-ignore */ decoderUrl);
}
