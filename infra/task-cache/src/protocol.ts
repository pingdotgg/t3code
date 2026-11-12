import { githubKeys } from "../vendor/vite-plus-remote-cache-cloudflare/src/auth.ts";

export { cborResponse } from "../vendor/vite-plus-remote-cache-cloudflare/src/cbor.ts";
export {
  cleanup,
  getScope,
  selectBlob,
} from "../vendor/vite-plus-remote-cache-cloudflare/src/database.ts";
export {
  errorResponse,
  HttpError,
} from "../vendor/vite-plus-remote-cache-cloudflare/src/errors.ts";
export { fetchMetadata } from "../vendor/vite-plus-remote-cache-cloudflare/src/fetch.ts";
export { defaults } from "../vendor/vite-plus-remote-cache-cloudflare/src/limits.ts";
export { store } from "../vendor/vite-plus-remote-cache-cloudflare/src/store.ts";
export { readBody, Deadline } from "../vendor/vite-plus-remote-cache-cloudflare/src/streams.ts";
export { Observations } from "../vendor/vite-plus-remote-cache-cloudflare/src/observations.ts";

export const keys = githubKeys();

export { authorizeCacheWrite, authorizeTelemetry } from "./telemetryAuth.ts";
