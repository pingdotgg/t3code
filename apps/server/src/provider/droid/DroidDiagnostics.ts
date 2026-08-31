import { causeErrorTag, errorTag } from "@t3tools/shared/observability";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

const diagnosticTextLimit = 2000;

type DroidDiagnosticValue = string | number | boolean | null;

export interface DroidDiagnosticOptions {
  readonly cause?: Cause.Cause<unknown>;
  readonly error?: unknown;
  readonly details?: Readonly<Record<string, DroidDiagnosticValue>>;
}

const annotations = (options?: DroidDiagnosticOptions) => ({
  ...options?.details,
  ...(options?.cause === undefined ? {} : { errorTag: causeErrorTag(options.cause) }),
  ...(options?.error === undefined ? {} : { errorTag: errorTag(options.error) }),
});

export const logDroidWarning = (message: string, options?: DroidDiagnosticOptions) =>
  Effect.logWarning(message.slice(0, diagnosticTextLimit), annotations(options));

export const logDroidError = (message: string, options?: DroidDiagnosticOptions) =>
  Effect.logError(message.slice(0, diagnosticTextLimit), annotations(options));
