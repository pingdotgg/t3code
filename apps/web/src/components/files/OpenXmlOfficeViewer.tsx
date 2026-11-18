import { useStableCallback } from "~/hooks/useStableCallback";
import type { OfficePreviewKind } from "@t3tools/shared/filePreview";
import { msg, T, useGT } from "gt-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { m } from "~/i18n/messages";
import {
  FileSurfaceLoading,
  FileSurfaceNotice,
  FILE_SURFACE_SUBHEADER_CLASS,
} from "./fileSurfaceChrome";
import { OFFICE_PREVIEW_MAX_BYTES, type OfficeWorkerResult } from "./officePreviewProtocol";
import { previewErrorText, previewFailureText } from "./previewFailureMessages";
const WordDocument = lazy(() => import("./office/WordDocument"));
const Spreadsheet = lazy(() => import("./office/Spreadsheet"));
const Presentation = lazy(() => import("./office/Presentation"));
async function readOfficeFile(src: string, signal: AbortSignal) {
  const response = await fetch(src, { signal });
  if (!response.ok)
    throw new Error(m(msg("The file could not be loaded. Close it and try again.")));
  if (Number(response.headers.get("content-length")) > OFFICE_PREVIEW_MAX_BYTES)
    throw new Error(m(msg("Preview limited to files under 50 MB.")));
  const reader = response.body?.getReader();
  if (!reader) throw new Error(m(msg("The file is unavailable.")));
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > OFFICE_PREVIEW_MAX_BYTES)
        throw new Error(m(msg("Preview limited to files under 50 MB.")));
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Blob(chunks).arrayBuffer();
}

export default function OfficeViewer(props: {
  readonly src: string;
  readonly name: string;
  readonly kind: Extract<OfficePreviewKind, "docx" | "xlsx" | "pptx">;
  readonly sizeBytes?: number;
}) {
  const gt = useGT();
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Extract<OfficeWorkerResult, { bytes: ArrayBuffer }>>();
  const [details, setDetails] = useState("");
  const fail = useStableCallback((cause: unknown) =>
    setError(previewErrorText(cause, m(msg("Could not render this Office document.")))),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the Open XML fetch, preparation worker, and timeout for this source and release them on cleanup.
  useEffect(() => {
    if ((props.sizeBytes ?? 0) > OFFICE_PREVIEW_MAX_BYTES) {
      // Metadata bounds are checked before fetching or starting an engine.
      // oxlint-disable-next-line react/set-state-in-effect
      setError(m(msg("Preview limited to files under 50 MB.")));
      return;
    }
    const controller = new AbortController();
    const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
      type: "module",
    });
    const failure = (cause: unknown) => {
      if (!controller.signal.aborted) fail(cause);
      controller.abort();
      worker.terminate();
    };
    const timer = setTimeout(
      () =>
        failure(
          new Error(m(msg("This document took too long to preview. Open it in another app."))),
        ),
      30000,
    );
    worker.addEventListener("error", () =>
      failure(new Error(m(msg("Could not load the Office viewer.")))),
    );
    worker.addEventListener("messageerror", () =>
      failure(new Error(m(msg("Could not read the Office viewer response.")))),
    );
    worker.addEventListener("message", (event: MessageEvent<OfficeWorkerResult>) => {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      if (event.data.type === "error") failure(new Error(previewFailureText(event.data)));
      else if ("bytes" in event.data) {
        setPrepared(event.data);
        worker.terminate();
      }
    });
    void readOfficeFile(props.src, controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted)
          worker.postMessage({ type: "open", kind: props.kind, bytes }, [bytes]);
      })
      .catch(failure);
    return () => {
      controller.abort();
      worker.terminate();
      clearTimeout(timer);
    };
  }, [props.src, props.kind, props.sizeBytes, fail]);
  if (error)
    return (
      <div
        role="alert"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center"
      >
        <p className="text-label">
          <T>No preview for this file</T>
        </p>
        <p className="max-w-sm text-meta leading-relaxed text-muted-foreground">
          {gt("{error} Save it or open it in another app.", { error })}
        </p>
      </div>
    );
  if (!prepared) return <FileSurfaceLoading />;
  const Viewer = props.kind === "docx" ? WordDocument : Presentation;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {details ? (
        <div className={FILE_SURFACE_SUBHEADER_CLASS}>
          <span className="text-meta text-muted-foreground" aria-live="polite">
            {details}
          </span>
        </div>
      ) : null}
      {prepared.truncated ? (
        <FileSurfaceNotice>
          <T>Preview limited. Save it or open it in another app to read the full document.</T>
        </FileSurfaceNotice>
      ) : null}
      <Suspense fallback={<FileSurfaceLoading />}>
        {prepared.view ? (
          <Spreadsheet
            bytes={prepared.bytes}
            view={prepared.view}
            onDetails={setDetails}
            onError={fail}
          />
        ) : (
          <Viewer bytes={prepared.bytes} onDetails={setDetails} onError={fail} />
        )}
      </Suspense>
    </div>
  );
}
