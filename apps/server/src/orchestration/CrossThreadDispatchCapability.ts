import { randomUUID } from "node:crypto";

import type { ThreadId } from "@t3tools/contracts";

const CAPABILITY_TTL_MS = 30_000;
const capabilities = new Map<
  string,
  { readonly sourceThreadId: ThreadId; readonly expiresAt: number }
>();

export function issueCrossThreadDispatchCapability(sourceThreadId: ThreadId): string {
  const token = randomUUID();
  capabilities.set(token, { sourceThreadId, expiresAt: Date.now() + CAPABILITY_TTL_MS });
  return token;
}

export function consumeCrossThreadDispatchCapability(
  token: string,
  sourceThreadId: ThreadId,
): boolean {
  const capability = capabilities.get(token);
  capabilities.delete(token);
  return (
    capability !== undefined &&
    capability.expiresAt >= Date.now() &&
    capability.sourceThreadId === sourceThreadId
  );
}
