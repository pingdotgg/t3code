import { useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState as RuntimeAssetUrlState,
  assetUrlStateFromResult,
  blockedAssetUrlState,
  EMPTY_ASSET_URL_ATOM,
  makeRevisionedAssetUrlFamily,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AssetResource, type AssetCreateUrlResult, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { assetEnvironment } from "~/state/assets";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

export type AssetUrlState = RuntimeAssetUrlState & { readonly waiting?: boolean };

const ASSET_URL_REFRESH_MARGIN_MS = 30_000;

/** Signed asset URLs expire; treat one close to expiry as stale so callers refetch. */
export function isAssetUrlCurrent(
  result: Pick<AssetCreateUrlResult, "expiresAt">,
  now = Date.now(),
): boolean {
  return result.expiresAt - ASSET_URL_REFRESH_MARGIN_MS > now;
}
const revisionedAssetUrl = makeRevisionedAssetUrlFamily(assetEnvironment.createUrl);

/**
 * Pass `revision` for a workspace file whose bytes can change under the same
 * path; each new revision gets a freshly minted URL.
 */
export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  revision?: string | null,
): AssetUrlState {
  const blocked = blockedAssetUrlState(
    resource,
    useFilesystemReadAccess(environmentId, useMessages()),
  );
  const preparedConnection = usePreparedConnection(environmentId);
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    reportDefect: false,
    refresh: true,
  });
  const result = useAtomValue(
    blocked !== null || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : revision === undefined
        ? assetEnvironment.createUrl({ environmentId, input: { resource } })
        : revisionedAssetUrl({ environmentId, input: { resource }, revision }),
  );
  const resultIsCurrent = result._tag === "Success" && isAssetUrlCurrent(result.value);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-mints a signed URL in the shared asset query once the server's expiry passes
  useEffect(() => {
    if (blocked !== null || environmentId === null || resource === null) return;
    // A refresh in flight keeps the stale success until it lands.
    if (result._tag !== "Success" || result.waiting || resultIsCurrent) return;
    void refresh({ environmentId, input: { resource } });
  }, [blocked, environmentId, refresh, resource, result, resultIsCurrent]);
  if (blocked !== null) return blocked;
  if (result._tag === "Success" && !resultIsCurrent) return { _tag: "Loading" };
  return {
    ...assetUrlStateFromResult(
      result,
      preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
    ),
    ...(result.waiting ? { waiting: true } : {}),
  };
}

export function useAssetUrlRefresh(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const result = await refresh({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
  };
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    reportDefect: false,
    refresh: true,
  });
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const allowedResources = canReadFiles
    ? resources
    : resources.filter((resource) => !isFileResource(resource));
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources: allowedResources,
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-mints signed URLs in the shared asset query once the server's expiry passes
  useEffect(() => {
    const expiredResources = allowedResources.filter((_, index) => {
      const result = results[index];
      return result?._tag === "Success" && !result.waiting && !isAssetUrlCurrent(result.value);
    });
    if (expiredResources.length === 0) return;
    void Promise.all(
      expiredResources.map((resource) => refresh({ environmentId, input: { resource } })),
    );
  }, [allowedResources, environmentId, refresh, results]);
  if (preparedConnection._tag === "None") return resources.map(() => null);
  const urls: Array<string | null> = [];
  let resultIndex = 0;
  for (const resource of resources) {
    if (!canReadFiles && isFileResource(resource)) {
      urls.push(null);
      continue;
    }
    const result = results[resultIndex];
    resultIndex += 1;
    urls.push(
      result && AsyncResult.isSuccess(result) && isAssetUrlCurrent(result.value)
        ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
        : null,
    );
  }
  return urls;
}

function isFileResource(resource: AssetResource): boolean {
  return (
    resource._tag === "workspace-file" ||
    resource._tag === "media-file" ||
    resource._tag === "draft-workspace-file" ||
    (resource._tag === "native-app-icon" && resource.app._tag === "app-path")
  );
}
