import { lazy, Suspense } from "react";
import { FileSurfaceLoading } from "./fileSurfaceChrome";

const LargeTextViewer = lazy(() => import("./LargeTextViewer"));
export function DelimitedTablePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly delimiter: "," | "\t";
  readonly revealLine?: number | null;
}) {
  return (
    <Suspense fallback={<FileSurfaceLoading />}>
      <LargeTextViewer key={props.name} {...props} />
    </Suspense>
  );
}
