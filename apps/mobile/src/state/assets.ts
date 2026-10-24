import { useAtomValue } from "@effect/atom-react";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import {
  assetUrlStateFromResult,
  blockedAssetUrlState,
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
  EMPTY_ASSET_URL_ATOM,
} from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { assetImageSource } from "../lib/assetImageSource";
import { projectFaviconDatabaseCache } from "../lib/projectFaviconDatabaseCache";
import { type AssetUrlState, deriveAssetUrlState } from "./asset-url-state";
import { environmentProjectCloneListAtom } from "./projectClones";
import { environmentSession, usePreparedConnection } from "./session";
import { useEnvironmentPresentation } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { useAtomQueryRunner } from "./use-atom-query-runner";

export type { AssetUrlFailureReason, AssetUrlState } from "./asset-url-state";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  imageCache: projectFaviconDatabaseCache,
  createUrl: assetEnvironment.createUrl,
  preparedConnection: environmentSession.preparedConnectionValueAtom,
  projectClones: environmentProjectCloneListAtom,
});

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
  const blocked = blockedAssetUrlState(resource, fileAccess);
  const preparedConnection = usePreparedConnection(environmentId);
  const connectionPhase = fileEnvironment.presentation?.connection.phase ?? "available";
  const result = useAtomValue(
    blocked !== null || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource, bindVersion: true } }),
  );
  const shared =
    blocked ??
    assetUrlStateFromResult(
      result,
      preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
    );
  return deriveAssetUrlState({
    connectionPhase,
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
      await createUrl({ environmentId, input: { resource, bindVersion: true } }),
      httpBaseUrl,
    );
    return state._tag === "Success" ? state.url : null;
  }, [createUrl, environmentId, httpBaseUrl, resource]);
}

/**
 * The server refuses a signed image URL once its file or GitHub credential
 * changes after signing, so a failed load re-signs once. The next retry waits
 * for a successful load, so an image that cannot decode does not re-sign forever.
 */
export function useAssetImageLoadRetry(
  uri: string | null,
  refresh: (() => Promise<string | null>) | undefined,
) {
  // A ref, since native can report two errors before React commits a state update.
  const retried = useRef(false);
  const [failedUri, setFailedUri] = useState<string | null>(null);
  return {
    failed: uri !== null && failedUri === uri,
    onLoad: () => {
      retried.current = false;
    },
    onError: () => {
      if (refresh === undefined || retried.current) {
        setFailedUri(uri);
        return;
      }
      retried.current = true;
      void refresh().then((next) => {
        if (next === null) setFailedUri(uri);
      });
    },
  };
}

export function useAssetImage(environmentId: EnvironmentId, resource: AssetResource | null) {
  const asset = useAssetUrlState(environmentId, resource);
  const refresh = useRefreshAssetUrl(environmentId, resource);
  const retry = useAssetImageLoadRetry(asset._tag === "Success" ? asset.url : null, refresh);
  return {
    ...retry,
    source:
      asset._tag === "Success" && resource !== null
        ? assetImageSource(environmentId, resource, asset)
        : null,
  };
}
