import type { EventId, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";

export function GeneratedImagePanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly activityId: EventId;
  readonly name: string;
  readonly loadRequestId: number;
}) {
  const assetUrl = useAssetUrlState(props.threadRef.environmentId, {
    _tag: "generated-image",
    threadId: props.threadRef.threadId,
    activityId: props.activityId,
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageUrl =
    assetUrl._tag === "Success"
      ? `${assetUrl.url}${assetUrl.url.includes("?") ? "&" : "?"}t3LoadRequest=${props.loadRequestId}`
      : null;

  if (assetUrl._tag === "Failure" || (imageUrl !== null && failedUrl === imageUrl)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load generated image.
      </div>
    );
  }

  if (imageUrl === null) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground"
        role="status"
      >
        Loading image…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        className="max-h-full max-w-full object-contain"
        src={imageUrl}
        alt={props.name}
        draggable={false}
        onError={() => setFailedUrl(imageUrl)}
      />
    </div>
  );
}
