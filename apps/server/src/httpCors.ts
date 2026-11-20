import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import { APP_SCHEME } from "@t3tools/shared/appScheme";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

export const DESKTOP_RENDERER_ORIGINS = [`${APP_SCHEME}://app`, `${APP_SCHEME}-dev://app`] as const;

/** MCP refuses every browser Origin with 403, so the browser CORS layer must not answer for it. */
export const MCP_HTTP_PATH = "/mcp";
