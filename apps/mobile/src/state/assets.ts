import { createAssetEnvironmentAtoms, resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { usePreparedConnection } from "./session";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

export interface AssetUrlState {
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
  readonly url: string | null;
}

/**
 * Signed URL for an asset, plus the request state a surface needs to explain itself. The URL can be
 * a stale success while `error` describes a failed refresh, so callers that must not show outdated
 * bytes should check `error` first.
 */
export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const query = useEnvironmentQuery(
    environmentId !== null && resource !== null
      ? assetEnvironment.createUrl({ environmentId, input: { resource } })
      : null,
  );
  const url =
    query.data !== null && Option.isSome(preparedConnection)
      ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, query.data.relativeUrl)
      : null;
  const resolutionError =
    query.data === null
      ? null
      : Option.isNone(preparedConnection)
        ? "The environment connection is unavailable."
        : url === null
          ? "The environment returned an invalid asset URL."
          : null;

  return {
    error: query.error ?? resolutionError,
    isPending: query.isPending,
    refresh: query.refresh,
    url,
  };
}

/** The asset URL only while it is current; a failed request reads as no URL rather than stale bytes. */
export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  const state = useAssetUrlState(environmentId, resource);
  return state.error === null ? state.url : null;
}
