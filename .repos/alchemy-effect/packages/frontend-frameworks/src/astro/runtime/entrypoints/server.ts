// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Vendored from `@astrojs/cloudflare` v14.1.3 (`src/entrypoints/server.ts`).
import { handle } from "../utils/handler.ts";

export default {
  fetch: handle,
} satisfies ExportedHandler<Env>;
