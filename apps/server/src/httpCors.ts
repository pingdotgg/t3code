import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import { BRAND_DESKTOP_PROTOCOLS } from "@t3tools/shared/brand";

export const browserApiCorsAllowedMethods = ["GET", "POST", "DELETE", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

export const DESKTOP_RENDERER_ORIGINS = BRAND_DESKTOP_PROTOCOLS.map(
  (protocol) => `${protocol}//app`,
);

/** MCP refuses every browser Origin with 403, so the browser CORS layer must not answer for it. */
export const MCP_HTTP_PATH = "/mcp";
