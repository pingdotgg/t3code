/**
 * Strict structural validator for `PickedElementPayload` messages received
 * from the in-page picker preload (`apps/desktop/src/preview-pick-preload.ts`)
 * via `wc.ipc`. Lives in its own electron-free module so the validator is
 * trivially unit-testable.
 *
 * Validation must be tight: downstream `normalizeElementContextSelection`
 * calls `.trim()` on incoming strings, so a malformed payload (preload bug,
 * future schema mismatch, malicious page that intercepts the preload's IPC
 * channel via prototype pollution) would otherwise throw deep in the
 * renderer and the chip silently never appears.
 */
import type { PickedElementPayload } from "@t3tools/contracts";

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isPickedStackFrame(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    isStringOrNull(frame["functionName"]) &&
    isStringOrNull(frame["fileName"]) &&
    isFiniteNumberOrNull(frame["lineNumber"]) &&
    isFiniteNumberOrNull(frame["columnNumber"])
  );
}

export function isPickedElementPayload(value: unknown): value is PickedElementPayload {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (typeof c["pageUrl"] !== "string") return false;
  if (typeof c["tagName"] !== "string") return false;
  if (typeof c["htmlPreview"] !== "string") return false;
  if (typeof c["styles"] !== "string") return false;
  if (typeof c["pickedAt"] !== "string") return false;
  if (!isStringOrNull(c["pageTitle"])) return false;
  if (!isStringOrNull(c["selector"])) return false;
  if (!isStringOrNull(c["componentName"])) return false;
  if (c["source"] !== null && !isPickedStackFrame(c["source"])) return false;
  if (!Array.isArray(c["stack"])) return false;
  if (!c["stack"].every(isPickedStackFrame)) return false;
  return true;
}
