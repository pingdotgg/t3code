import { lazy, Suspense } from "react";

import { FileSurfaceLoading } from "./fileSurfaceChrome";

const FontViewer = lazy(() => import("./FontViewer"));

export function FontFilePreview(props: { readonly src: string; readonly name: string }) {
  return (
    <Suspense fallback={<FileSurfaceLoading />}>
      <FontViewer key={props.src} {...props} />
    </Suspense>
  );
}
