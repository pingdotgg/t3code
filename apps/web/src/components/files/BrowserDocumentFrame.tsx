import { useEffect, useState } from "react";

import { FileSurfaceFailure } from "./fileSurfaceChrome";

/**
 * Chromium's viewer opens with its own toolbar, a thumbnail rail and a small
 * zoom. The panel header is the only chrome we want, so ask for the page
 * alone, fitted to the panel width. Pinch and keyboard zoom, scrolling, text
 * selection and find still work inside the frame.
 */
const PDF_VIEWER_FRAGMENT = "#toolbar=0&view=FitH";

export const isPdfPreviewFile = (path: string): boolean =>
  /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");

/**
 * Whether a content security policy violation reported on the host document is
 * this frame being refused. A refused frame renders an error page the parent
 * cannot read, so this event is the only signal that it happened. Cross-origin
 * violations report `blockedURI` stripped to the origin, so the origin is as
 * much as the two URLs can be compared on.
 */
export function isBlockedFrameViolation(
  src: string,
  violation: { readonly directive: string; readonly blockedURI: string },
): boolean {
  const directive = violation.directive.split(/[\s;]/, 1)[0];
  if (directive !== "frame-src" && directive !== "child-src") return false;
  try {
    return new URL(violation.blockedURI).origin === new URL(src).origin;
  } catch {
    return false;
  }
}

/**
 * Renders an HTML or PDF document from its URL. HTML runs in a sandboxed frame
 * with an opaque origin, so a page cannot reach the app's session or storage.
 * The built-in PDF viewer needs an unsandboxed frame; a PDF runs no scripts.
 *
 * A frame that never loads leaves a blank white pane, because its error page
 * belongs to the frame and not to us. Report the failure and offer a reload
 * rather than showing that empty pane. Remounting on `src` and on each reload
 * clears a stale failure and retries the request.
 */
export function BrowserDocumentFrame(props: {
  readonly src: string;
  readonly title: string;
  readonly pdf: boolean;
}) {
  const [reloadCount, setReloadCount] = useState(0);
  return (
    <DocumentFrame
      key={`${props.src}#${reloadCount}`}
      src={props.src}
      title={props.title}
      pdf={props.pdf}
      onReload={() => setReloadCount((count) => count + 1)}
    />
  );
}

function DocumentFrame(props: {
  readonly src: string;
  readonly title: string;
  readonly pdf: boolean;
  readonly onReload: () => void;
}) {
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      const directive = event.effectiveDirective || event.violatedDirective;
      if (isBlockedFrameViolation(props.src, { directive, blockedURI: event.blockedURI })) {
        setFailure("This document was blocked by the app's security policy.");
      }
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    return () => document.removeEventListener("securitypolicyviolation", onViolation);
  }, [props.src]);

  // A frame reports nothing a parent can act on: a navigation that fails does
  // not fire `error`, and the error page it commits is cross-origin. Ask the
  // server the same question the frame is asking, which is one extra HEAD per
  // document opened. A `blob:` document is already in memory and answers only
  // GET, so there is nothing to ask about it.
  useEffect(() => {
    if (props.src.startsWith("blob:")) return;
    const controller = new AbortController();
    void fetch(props.src, { method: "HEAD", signal: controller.signal })
      .then((response) => {
        if (!response.ok) setFailure("This document is no longer available.");
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailure("Could not reach the environment serving this document.");
        }
      });
    return () => controller.abort();
  }, [props.src]);

  if (failure !== null) {
    return <FileSurfaceFailure message={failure} onRetry={props.onReload} />;
  }

  const className = "min-h-0 flex-1 border-0 bg-white";
  return props.pdf ? (
    // oxlint-disable-next-line react/iframe-missing-sandbox
    <iframe src={`${props.src}${PDF_VIEWER_FRAGMENT}`} title={props.title} className={className} />
  ) : (
    <iframe
      src={props.src}
      title={props.title}
      className={className}
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
    />
  );
}
