import { useAtomValue } from "@effect/atom-react";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import {
  assetUrlStateFromResult,
  createAssetEnvironmentAtoms,
  EMPTY_ASSET_URL_ATOM,
} from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { type AssetUrlState, deriveAssetUrlState } from "./asset-url-state";
import { environmentSession, usePreparedConnection } from "./session";
import { useEnvironmentPresentation } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { useAtomQueryRunner } from "./use-atom-query-runner";

export type { AssetUrlFailureReason, AssetUrlState } from "./asset-url-state";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const fileAccessSession = useEnvironmentQuery(
    environmentId === null ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(environmentId);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const canReadResource =
    fileAccess.canReadFiles ||
    (resource?._tag !== "workspace-file" && resource?._tag !== "media-file");
  const preparedConnection = usePreparedConnection(environmentId);
  const connectionPhase = fileEnvironment.presentation?.connection.phase ?? "available";
  const result = useAtomValue(
    !canReadResource || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  const shared = !canReadResource
    ? fileAccess.isPending
      ? { _tag: "Loading" as const }
      : { _tag: "Failure" as const }
    : assetUrlStateFromResult(
        result,
        preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
      );
  return deriveAssetUrlState({
    connectionPhase,
    // A failure left over from an outage is re-queried as soon as the
    // connection returns. While that re-query is in flight it is not a verdict
    // on the file, so it reads as loading rather than a false "unavailable".
    shared: shared._tag === "Failure" && result.waiting ? { _tag: "Loading" } : shared,
  });
}

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  const state = useAssetUrlState(environmentId, resource);
  return state._tag === "Success" ? state.url : null;
}

/** Explicit playback and sharing must reauthorize files that may have been replaced on disk. */
export function useRefreshAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  return useCallback(async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const state = assetUrlStateFromResult(
      await createUrl({ environmentId, input: { resource } }),
      httpBaseUrl,
    );
    return state._tag === "Success" ? state.url : null;
  }, [createUrl, environmentId, httpBaseUrl, resource]);
}
