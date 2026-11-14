import type * as AcpError from "./errors.ts";

/**
 * Stable JSON-RPC identity for a request id. Effect's RPC layer and the ACP
 * extension ids are different namespaces, so each shape carries its own prefix
 * and a bare string id is passed through unchanged.
 */
export function acpRequestIdentity(requestId: AcpError.AcpRequestId): string {
  const prefix = "$t3:jsonrpc:";
  if (typeof requestId === "number") return `${prefix}number:${requestId}`;
  return requestId.startsWith(prefix) ? `${prefix}string:${requestId}` : requestId;
}
