import { lazy, Suspense } from "react";

import { FileSurfaceLoading } from "./fileSurfaceChrome";

const BinaryViewer = lazy(() => import("./BinaryViewer"));

export function BinaryFilePreview(props: {
  readonly src: string;
  readonly name: string;
  readonly kind: "archive" | "sqlite";
  readonly onRetry?: () => void;
}) {
  return (
    <Suspense fallback={<FileSurfaceLoading />}>
      <BinaryViewer key={props.src} {...props} />
    </Suspense>
  );
}
