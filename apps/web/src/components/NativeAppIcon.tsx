import type { EnvironmentId } from "@t3tools/contracts";
import { AppWindowIcon } from "lucide-react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";

/** The host's icon for a bundle id, with a generic window glyph until it resolves. */
export function NativeAppIcon(props: {
  environmentId: EnvironmentId | null;
  bundleId: string;
  className?: string;
}) {
  const asset = useAssetUrlState(props.environmentId, {
    _tag: "native-app-icon",
    app: { _tag: "app-id", appId: props.bundleId },
  });
  if (asset._tag !== "Success") {
    return <AppWindowIcon className={cn("shrink-0", props.className)} aria-hidden />;
  }
  return (
    <img
      src={asset.url}
      alt=""
      aria-hidden
      decoding="async"
      referrerPolicy="no-referrer"
      className={cn("shrink-0 rounded-[3px] object-contain", props.className)}
    />
  );
}
