import type { EnvironmentId, EventId, ScopedThreadRef } from "@t3tools/contracts";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";

export function GeneratedImagePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly activityId: EventId;
  readonly name: string;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, {
    _tag: "generated-image",
    threadId: props.threadRef.threadId,
    activityId: props.activityId,
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (assetUrl._tag === "Failure" || (assetUrl._tag === "Success" && failedUrl === assetUrl.url)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load generated image.
      </div>
    );
  }

  return assetUrl._tag === "Success" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        className="max-h-full max-w-full object-contain"
        src={assetUrl.url}
        alt={props.name}
        onError={() => setFailedUrl(assetUrl.url)}
      />
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" />
    </div>
  );
}
