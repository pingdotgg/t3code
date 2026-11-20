import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useCallback, useState } from "react";

import { Notice } from "../artifacts/Notice";
import { PdfPage } from "./PdfPage";

GlobalWorkerOptions.workerSrc = workerUrl;

/** A PDF as pages, drawn as they scroll into view. The bytes come from a signed URL. */
export function PdfPages({ url }: { url: string }) {
  const [state, setState] = useState<
    | { readonly status: "loading" }
    | { readonly status: "failed"; readonly message: string }
    | { readonly status: "ready"; readonly document: PDFDocumentProxy }
  >({ status: "loading" });
  const open = useCallback(
    (frame: HTMLDivElement | null) => {
      if (frame === null) return;
      let stopped = false;
      const loading = getDocument({ url, useSystemFonts: true, useWorkerFetch: false });
      void (async () => {
        try {
          const document = await loading.promise;
          if (!stopped) setState({ status: "ready", document });
        } catch (error) {
          if (!stopped) {
            setState({
              status: "failed",
              message: error instanceof Error ? error.message : "The PDF could not be opened.",
            });
          }
        }
      })();
      return () => {
        stopped = true;
        void loading.destroy();
      };
    },
    [url],
  );
  return (
    <div
      ref={open}
      data-testid="pdf-pages"
      className="flex min-h-0 flex-1 flex-col overflow-auto bg-bg"
    >
      {state.status === "loading" && <Notice>Loading the PDF</Notice>}
      {state.status === "failed" && <Notice tone="text-red-300">{state.message}</Notice>}
      {state.status === "ready" && (
        <div className="flex flex-col gap-2 p-2">
          {Array.from({ length: state.document.numPages }, (_, index) => (
            // Pages never reorder, so the number identifies one.
            <PdfPage key={index} document={state.document} index={index} />
          ))}
        </div>
      )}
    </div>
  );
}
