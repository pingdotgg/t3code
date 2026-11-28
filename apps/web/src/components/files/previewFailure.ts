import { isZipError } from "@t3tools/client-runtime/zip/error";
import * as Schema from "effect/Schema";
import type { PreviewFailureCode } from "./previewFailureMessages";

/** A preview failure that crosses a worker boundary: a code the window translates, or text from a library. */
export type PreviewFailure = { readonly message: string; readonly code?: PreviewFailureCode };

/** Thrown where catalogs are not loaded (workers); the window shows `previewFailureText`. */
export class PreviewError extends Schema.TaggedError<PreviewError>()("PreviewError", {
  code: Schema.declare((value: unknown): value is PreviewFailureCode => typeof value === "string"),
}) {}

export const isPreviewError = Schema.is(PreviewError);

export function previewFailure(cause: unknown, fallback: PreviewFailureCode): PreviewFailure {
  if (isPreviewError(cause)) return { code: cause.code, message: cause.code };
  if (isZipError(cause)) return { code: cause.code, message: cause.message };
  if (cause instanceof Error) return { message: cause.message };
  return { code: fallback, message: fallback };
}
