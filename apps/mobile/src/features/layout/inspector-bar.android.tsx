import type { ReactNode } from "react";

import { InspectorBarScope, useInspectorBarStore } from "./inspector-bar-store";

/** AppBar draws the bar inline on Android; the scope keeps its options off the thread's route. */
export function InspectorBar(props: {
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const store = useInspectorBarStore();
  return (
    <InspectorBarScope store={store} onClose={props.onClose}>
      {props.children}
    </InspectorBarScope>
  );
}
