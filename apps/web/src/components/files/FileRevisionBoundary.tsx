import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { Fragment, useState, type ReactNode } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";

/**
 * Keeps a preview mounted while its file is unchanged. Each move of `refreshToken` (a command or
 * edit anywhere in the thread, a manual refresh) checks the file's revision; only a new one
 * remounts the preview. Servers that report no revision remount it on every move.
 */
export function FileRevisionBoundary(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: AssetResource;
  readonly refreshToken: string;
  readonly children: ReactNode;
}) {
  const asset = useAssetUrlState(props.environmentId, props.resource, props.refreshToken);
  // While a check runs, or when it fails, the preview stays as it is.
  const revision =
    asset._tag === "Success" ? (asset.fileRevision ?? `unknown:${props.refreshToken}`) : null;
  const [shown, setShown] = useState<{
    revision: string | null;
    generation: number;
    failed: boolean;
  }>({ revision: null, generation: 0, failed: false });
  // A preview opened while its file could not be read failed too: it retries once the file can be.
  if (asset._tag === "Failure" && shown.revision === null && !shown.failed)
    setShown({ ...shown, failed: true });
  if (revision !== null && revision !== shown.revision)
    setShown({
      revision,
      failed: false,
      // The first revision read is the one the preview opened with.
      generation:
        shown.revision === null && !shown.failed ? shown.generation : shown.generation + 1,
    });
  return <Fragment key={shown.generation}>{props.children}</Fragment>;
}
