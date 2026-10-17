import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ThreadMcpServerStatus = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: Schema.Literals(["connected", "pending", "needsAuth", "failed", "disabled", "unknown"]),
  authStatus: Schema.String,
  toolCount: NonNegativeInt,
});
export type ThreadMcpServerStatus = typeof ThreadMcpServerStatus.Type;

export const ThreadMcpLoginStarted = Schema.Struct({
  loginId: TrimmedNonEmptyString,
  authorizationUrl: Schema.String,
});
export type ThreadMcpLoginStarted = typeof ThreadMcpLoginStarted.Type;
