import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { ImageCiteContext, type MediaActionsSource } from "../../lib/mediaActions";
import { ImageRegionCiteModal } from "./ImageRegionCiteModal";

/** Lets image menus under a thread offer "Cite region" into that thread's draft. */
export function ImageCiteProvider(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly children: ReactNode;
}) {
  const [source, setSource] = useState<MediaActionsSource | null>(null);
  return (
    <ImageCiteContext value={setSource}>
      {props.children}
      {source ? (
        <ImageRegionCiteModal
          source={source}
          environmentId={props.environmentId}
          threadId={props.threadId}
          onClose={() => setSource(null)}
        />
      ) : null}
    </ImageCiteContext>
  );
}
