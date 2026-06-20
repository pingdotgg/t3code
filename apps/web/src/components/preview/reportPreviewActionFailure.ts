import { getUrlDiagnostics } from "@t3tools/shared/urlDiagnostics";

export interface PreviewActionFailureContext {
  readonly operation: string;
  readonly threadKey?: string;
  readonly tabId?: string;
  readonly urlHostname?: string;
  readonly urlLength?: number;
  readonly urlProtocol?: string;
  readonly artifactPath?: string;
  readonly annotationId?: string;
  readonly trigger?: string;
}

export function previewUrlFailureContext(url: string) {
  const diagnostics = getUrlDiagnostics(url);
  return {
    urlLength: diagnostics.inputLength,
    ...(diagnostics.hostname === undefined ? {} : { urlHostname: diagnostics.hostname }),
    ...(diagnostics.protocol === undefined ? {} : { urlProtocol: diagnostics.protocol }),
  };
}

export function reportPreviewActionFailure(
  context: PreviewActionFailureContext,
  cause: unknown,
): void {
  console.error("[preview] action failed", context, cause);
}
