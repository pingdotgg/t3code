import { useStableCallback } from "~/hooks/useStableCallback";
import type { OfficePreviewKind } from "@t3tools/shared/filePreview";
import { lazy, Suspense, useEffect, useState } from "react";
import {
  FileSurfaceLoading,
  FileSurfaceNotice,
  FILE_SURFACE_SUBHEADER_CLASS,
} from "./fileSurfaceChrome";
import { OFFICE_PREVIEW_MAX_BYTES, type OfficeWorkerResult } from "./officePreviewProtocol";
import { translateNow } from "~/components/media/translateNow";
import { useT } from "~/hooks/useI18n";
const WordDocument = lazy(() => import("./office/WordDocument"));
const Spreadsheet = lazy(() => import("./office/Spreadsheet"));
const Presentation = lazy(() => import("./office/Presentation"));
async function readOfficeFile(src: string, signal: AbortSignal) {
  const t = translateNow;
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error(t("review.extra.the.file.could.not.be.loaded.close.it"));
  if (Number(response.headers.get("content-length")) > OFFICE_PREVIEW_MAX_BYTES)
    throw new Error(t("review.extra.preview.limited.to.files.under.50.mb"));
  const reader = response.body?.getReader();
  if (!reader) throw new Error(t("review.extra.the.file.is.unavailable"));
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > OFFICE_PREVIEW_MAX_BYTES)
        throw new Error(t("review.extra.preview.limited.to.files.under.50.mb"));
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
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Extract<OfficeWorkerResult, { bytes: ArrayBuffer }>>();
  const [details, setDetails] = useState("");
  const fail = useStableCallback((cause: unknown) =>
    setError(
      cause instanceof Error
        ? cause.message
        : translateNow("review.extra.could.not.render.this.office.document"),
    ),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the Open XML fetch, preparation worker, and timeout for this source and release them on cleanup.
  useEffect(() => {
    const t = translateNow;
    if ((props.sizeBytes ?? 0) > OFFICE_PREVIEW_MAX_BYTES) {
      // Metadata bounds are checked before fetching or starting an engine.
      // oxlint-disable-next-line react/set-state-in-effect
      setError(t("review.extra.preview.limited.to.files.under.50.mb"));
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
          new Error(translateNow("review.extra.this.document.took.too.long.to.preview.open")),
        ),
      30000,
    );
    worker.addEventListener("error", () =>
      failure(new Error(translateNow("review.extra.could.not.load.the.office.viewer"))),
    );
    worker.addEventListener("messageerror", () =>
      failure(new Error(translateNow("review.extra.could.not.read.the.office.viewer.response"))),
    );
    worker.addEventListener("message", (event: MessageEvent<OfficeWorkerResult>) => {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      if (event.data.type === "error") failure(new Error(event.data.message));
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
        <p className="text-sm font-medium">{t("review.extra.no.preview.for.this.file")}</p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          {error}
          {t("review.extra.save.it.or.open.it.in.another.app")}
        </p>
      </div>
    );
  if (!prepared) return <FileSurfaceLoading />;
  const Viewer =
    props.kind === "docx" ? WordDocument : props.kind === "xlsx" ? Spreadsheet : Presentation;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {details ? (
        <div className={FILE_SURFACE_SUBHEADER_CLASS}>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {details}
            {props.kind !== "xlsx" ? t("review.extra.fit.to.width") : ""}
          </span>
        </div>
      ) : null}
      {prepared.truncated ? (
        <FileSurfaceNotice>
          {t("review.extra.preview.limited.save.it.or.open.it.in")}
        </FileSurfaceNotice>
      ) : null}
      <Suspense fallback={<FileSurfaceLoading />}>
        <Viewer bytes={prepared.bytes} onDetails={setDetails} onError={fail} />
      </Suspense>
    </div>
  );
}
