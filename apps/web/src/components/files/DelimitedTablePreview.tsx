import { lazy, Suspense } from "react";
import { FileSurfaceLoading } from "./fileSurfaceChrome";
import { definePluginComponent } from "~/plugins/features";

export const DelimitedTablePreview = definePluginComponent(
  "component:components/files/DelimitedTablePreview/DelimitedTablePreview",
  PluginOriginalDelimitedTablePreview,
);

const LargeTextViewer = lazy(() => import("./LargeTextViewer"));
function PluginOriginalDelimitedTablePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly delimiter: "," | "\t";
}) {
  return (
    <Suspense fallback={<FileSurfaceLoading />}>
      <LargeTextViewer key={props.name} {...props} />
    </Suspense>
  );
}
