/**
 * Preview diagnostics classification for the web client's own telemetry.
 *
 * The OTLP trace exporter POSTs to `/api/observability/v1/traces` on an
 * interval. When the preview navigates mid-export, Chromium aborts the
 * in-flight request and the automation snapshot would otherwise surface it
 * as a failed request. An aborted telemetry export is never actionable, so
 * it is dropped here. Everything else stays recorded: non-abort failures of
 * the same endpoint, and aborted requests to any other endpoint. Keep this
 * scoped to the exact endpoint — a blanket aborted-request exclusion would
 * hide real failures.
 */
const CLIENT_TRACES_PATHNAME = "/api/observability/v1/traces";
const CHROMIUM_ABORT_ERROR = "net::ERR_ABORTED";

export function isBenignAbortedTraceExport(input: {
  readonly url: string;
  readonly errorText: string;
}): boolean {
  if (input.errorText !== CHROMIUM_ABORT_ERROR) return false;
  try {
    return new URL(input.url).pathname === CLIENT_TRACES_PATHNAME;
  } catch {
    return false;
  }
}
