import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { createAssetEnvironmentAtoms, resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePreparedConnection } from "./session";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_ASSET_URL_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-asset-url:empty"),
);

export interface AssetUrlState {
  readonly url: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const atom =
    environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const url =
    preparedConnection._tag === "None" || result._tag !== "Success"
      ? null
      : resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl);

  return {
    url,
    isPending: result.waiting,
    refresh,
  };
}

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  return useAssetUrlState(environmentId, resource).url;
}
