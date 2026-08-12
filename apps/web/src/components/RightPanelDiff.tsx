import type { ScopedThreadRef } from "@t3tools/contracts";

import type { DiffRouteSearch } from "../diffRouteSearch";
import DiffPanel from "./DiffPanel";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function RightPanelDiff(props: {
  readonly threadRef: ScopedThreadRef;
  readonly diffSearch: DiffRouteSearch;
  readonly onDiffSearchChange: (nextSearch: DiffRouteSearch) => void;
}) {
  return (
    <DiffWorkerPoolProvider>
      <DiffPanel
        mode="sheet"
        threadRef={props.threadRef}
        diffSearch={props.diffSearch}
        onDiffSearchChange={props.onDiffSearchChange}
      />
    </DiffWorkerPoolProvider>
  );
}
