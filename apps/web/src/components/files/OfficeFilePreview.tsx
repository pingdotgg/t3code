import type { OfficePreviewKind } from "@t3tools/shared/filePreview";
import { lazy, Suspense } from "react";

import { FileSurfaceLoading } from "./fileSurfaceChrome";

const OfficeViewer = lazy(() => import("./OfficeViewer"));

export function OfficeFilePreview(props: {
  readonly src: string;
  readonly name: string;
  readonly kind: OfficePreviewKind;
  readonly sizeBytes?: number;
}) {
  return (
    <Suspense fallback={<FileSurfaceLoading />}>
      <OfficeViewer key={JSON.stringify([props.src, props.kind, props.sizeBytes])} {...props} />
    </Suspense>
  );
}
