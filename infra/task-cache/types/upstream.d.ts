// The source-only upstream package expects Wrangler-generated globals but does not ship them.
import type * as Cloudflare from "@cloudflare/workers-types";
import type { ProtocolBindings } from "../src/protocolTypes.ts";

declare global {
  interface Env extends ProtocolBindings {}
  type D1Database = Cloudflare.D1Database;
  type D1Result<T = unknown> = Cloudflare.D1Result<T>;
  type R2MultipartUpload = Cloudflare.R2MultipartUpload;
  type R2UploadedPart = Cloudflare.R2UploadedPart;
  type ExecutionContext = Cloudflare.ExecutionContext;
}
