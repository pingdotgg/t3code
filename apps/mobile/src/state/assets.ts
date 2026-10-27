import { useAtomMount, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import {
  assetUrlStateFromResult,
  blockedAssetUrlState,
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
  EMPTY_ASSET_URL_ATOM,
} from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { projectFaviconDatabaseCache } from "../lib/projectFaviconDatabaseCache";
import { type AssetUrlState, deriveAssetUrlState } from "./asset-url-state";
import { appAtomRegistry } from "./atom-registry";
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
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
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
      await createUrl({ environmentId, input: { resource } }),
      httpBaseUrl,
    );
    return state._tag === "Success" ? state.url : null;
  }, [createUrl, environmentId, httpBaseUrl, resource]);
}

/** {@link useRefreshAssetUrl} for async tasks that resolve several resources at once. */
export async function refreshAssetUrl(
  environmentId: EnvironmentId,
  resource: AssetResource,
  signal?: AbortSignal,
): Promise<string | null> {
  const connectionAtom = environmentSession.preparedConnectionValueAtom(environmentId);
  if (appAtomRegistry.get(connectionAtom)._tag === "None") return null;
  const atom = assetEnvironment.createUrl({ environmentId, input: { resource } });
  const result = await executeAtomQuery(appAtomRegistry, atom, {
    label: atom.label?.[0] ?? "asset url",
    refresh: true,
    reportFailure: false,
    ...(signal ? { signal } : {}),
  });
  // A route can change while the query runs; resolve against the connection now current.
  const connection = appAtomRegistry.get(connectionAtom);
  if (connection._tag === "None") return null;
  const state = assetUrlStateFromResult(result, connection.value.httpBaseUrl);
  return state._tag === "Success" ? state.url : null;
}

export interface AuthorizedAssetUrl {
  readonly url: string;
  readonly authorizedAt: number;
}

interface FreshAssetUrlKey {
  readonly environmentId: EnvironmentId | null;
  readonly resource: AssetResource;
  /** A reconnect changes the base URL, and any URL minted against the old one is unusable. */
  readonly httpBaseUrl: string | null;
  /** Bumped by Retry so a file replaced on disk is reauthorized. */
  readonly revision: number;
}

// Plain-object keys compare structurally (Effect `Equal`/`Hash`).
const freshAssetUrlFamily = Atom.family((key: FreshAssetUrlKey) =>
  Atom.make(
    Effect.tryPromise({
      try: async (signal): Promise<AuthorizedAssetUrl> => {
        const url =
          key.environmentId === null
            ? null
            : await refreshAssetUrl(key.environmentId, key.resource, signal);
        if (!url) throw new Error("Reconnect to this environment and try again.");
        return { url, authorizedAt: Date.now() };
      },
      catch: (cause) =>
        cause instanceof Error ? cause : new Error("The attachment is unavailable."),
    }),
  ).pipe(Atom.withLabel("fresh-asset-url")),
);

const noFreshAssetUrl = Atom.make(AsyncResult.initial<AuthorizedAssetUrl, Error>()).pipe(
  Atom.withLabel("fresh-asset-url:none"),
);
const noSessionGeneration = Atom.make(0);

/**
 * A signed URL minted when the reader mounts, not a cached one: cached links can
 * expire while the client is suspended.
 */
export function useFreshAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  revision: number,
): AsyncResult.AsyncResult<AuthorizedAssetUrl, Error> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const atom =
    resource === null
      ? noFreshAssetUrl
      : freshAssetUrlFamily({ environmentId, resource, httpBaseUrl, revision });
  // Minting fails at once while the environment is unreachable; mint again once a new session is
  // up instead of keeping the error until Retry.
  const sessionGeneration =
    environmentId === null
      ? noSessionGeneration
      : environmentCatalog.sessionGenerationAtom(environmentId);
  // A listener alone does not compute the atom, so nothing would follow the connection.
  useAtomMount(sessionGeneration);
  useAtomSubscribe(sessionGeneration, () => {
    if (AsyncResult.isFailure(appAtomRegistry.get(atom))) appAtomRegistry.refresh(atom);
  });
  return useAtomValue(atom);
}
